import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { prepare, registration, runtime } from "../scripts/config.mjs";
import { runTrigger } from "../scripts/run-trigger.mjs";

function fixture() {
  const c = { run: "localtest", subscriptionId: randomUUID(), tenantId: randomUUID(),
    resourceGroup: "rg-builder-connectors-localtest", location: "westus2",
    apiClientId: randomUUID(), apiServicePrincipalId: randomUUID(), roleId: randomUUID(),
    appOrigin: "https://receiver.example.invalid", connectionRuntimeUrl: "https://connection.example.invalid/apim/office365/test",
  };
  const scope = `/subscriptions/${c.subscriptionId}/resourceGroups/${c.resourceGroup}/providers`;
  c.appResourceId = `${scope}/Microsoft.Web/builderApps/bld-connectors-${c.run}`;
  c.namespaceResourceId = `${scope}/Microsoft.Web/connectorGateways/cn-builder-${c.run}`;
  for (const kind of ["app", "trigger", "negative"]) c[`${kind}Identity`] = {
    id: `${scope}/Microsoft.ManagedIdentity/userAssignedIdentities/id-bld-${kind}-${c.run}`,
    clientId: randomUUID(), principalId: randomUUID(),
  };
  c.entraSetup = {
    federatedCredentialIssuer: `https://login.microsoftonline.com/${c.tenantId}/v2.0`,
    federatedCredentialSubject: c.appIdentity.principalId, federatedCredentialAudience: "api://AzureADTokenExchange",
  };
  return c;
}

test("registration requests strict app-token shape without Graph permissions or secrets", () => {
  const role = randomUUID();
  const body = registration("localtest", role);
  assert.equal(body.api.requestedAccessTokenVersion, 2);
  assert.equal(body.optionalClaims.accessToken[0].name, "idtyp");
  assert.deepEqual(body.appRoles[0].allowedMemberTypes, ["Application"]);
  assert.equal(body.appRoles[0].id, role);
  assert.deepEqual(body.requiredResourceAccess, []);
  assert(!("passwordCredentials" in body));
  assert(!("serviceManagementReference" in body));
  const serviceTree = randomUUID();
  assert.equal(registration("localtest", role, serviceTree).serviceManagementReference, serviceTree);
  assert.throws(() => registration("../wrong", role));
});

test("configuration keeps callback authorization and outbound connection identities separate", () => {
  const c = fixture(), p = prepare(c), r = runtime(c);
  const auth = p["auth-policy"].properties;
  assert.equal(auth.mode, "required");
  assert.deepEqual(auth.entraId.objectIds, [c.triggerIdentity.principalId]);
  assert.deepEqual(auth.entraId.customerApplication.allowedAudiences, [c.apiClientId]);
  assert.equal(p["app-policy"].properties.principal.identity.objectId, c.appIdentity.principalId);
  assert.equal(p["trigger-policy"].properties.principal.identity.objectId, c.triggerIdentity.principalId);
  assert(!("negative-policy" in p));
  for (const name of ["trigger-grant", "negative-grant"]) {
    assert.equal(p[name].resourceId, c.apiServicePrincipalId);
    assert.equal(p[name].appRoleId, c.roleId);
  }
  const mail = r["mail-trigger"].properties;
  assert.equal(mail.state, "Disabled");
  assert.equal(mail.settings.disableSplitOn, true);
  assert.deepEqual(mail.parameters, [{ name: "folderPath", value: "Inbox" }, { name: "subjectFilter", value: "[builder-connector-localtest]" }]);
  assert.equal(mail.notificationDetails.authentication.audience, `api://${c.apiClientId}`);
  assert.equal(mail.notificationDetails.authentication.identity, c.triggerIdentity.id);
  assert(!("metadata" in mail) && !("body" in mail.notificationDetails));
  assert.deepEqual(r["control-negative"].properties.notificationDetails.body, { body: { value: [] } });
  assert.equal(r["control-negative"].properties.notificationDetails.authentication.identity, c.negativeIdentity.id);
  assert.equal(r["control-wrong-audience"].properties.notificationDetails.authentication.audience, "https://management.azure.com/");
  assert.equal(r.variables.properties.versionConfiguration.variables[0].value, c.appIdentity.clientId);
  assert.equal(r.federation.subject, c.appIdentity.principalId);
});

test("configuration rejects cross-experiment identities and invented federation", () => {
  for (const mutate of [
    c => { c.triggerIdentity.principalId = c.appIdentity.principalId; },
    c => { c.appIdentity.id += "-different"; },
    c => { c.resourceGroup = "shared"; },
    c => { c.entraSetup.federatedCredentialSubject = randomUUID(); },
    c => { c.appOrigin = "http://receiver.example.invalid"; },
    c => { c.connectionRuntimeUrl += "?secret=not-allowed"; },
  ]) {
    const c = fixture(); mutate(c);
    assert.throws(() => runtime(c));
  }
});

function transport(outcome, failRuns = false) {
  let state = "Disabled", listing = 0;
  const changes = [];
  return { changes, request: async ({ method, path, body, query }) => {
    if (method === "put") { state = body.properties.state; changes.push(state); return; }
    if (query === "properties.state") return state;
    if (path.endsWith("/runs")) {
      if (listing++ === 0) return [];
      if (failRuns) throw new Error("Management read failed");
      return [{ id: "synthetic-run", status: "Succeeded" }];
    }
    return outcome;
  } };
}
test("bounded controls require exact outcomes and disable before returning", async () => {
  for (const [kind, outcome] of [
    ["control-negative", { httpStatus: 403 }],
    ["control-wrong-audience", { httpStatus: 401 }],
    ["control-allowed", { httpStatus: 200, received: 0, flagged: 0 }],
    ["mail-trigger", { httpStatus: 200, received: 1, flagged: 1 }],
  ]) {
    const fake = transport(outcome);
    const result = await runTrigger({ c: fixture(), kind, request: fake.request });
    assert.equal(result.finalState, "Disabled");
    assert.deepEqual(fake.changes, ["Enabled", "Disabled"]);
  }
});
test("unexpected HTTP, failed reads, timeout and interruption never leave trigger enabled", async () => {
  for (const options of [{}, { fail: true }, { timeout: true }, { interrupted: true }]) {
    const fake = transport({ httpStatus: 401 }, options.fail);
    let tick = 0;
    const signal = { aborted: false };
    await assert.rejects(runTrigger({
      c: fixture(), kind: "control-negative", request: fake.request,
      now: () => options.timeout ? tick++ * 200000 : 0,
      signal, onEnabled: () => { signal.aborted = !!options.interrupted; },
    }));
    assert.deepEqual(fake.changes, ["Enabled", "Disabled"]);
  }
});

test("cancellation before enable makes no state write", async () => {
  const fake = transport({});
  await assert.rejects(runTrigger({
    c: fixture(), kind: "control-allowed", request: fake.request, signal: { aborted: true },
  }), /Cancelled before enable/);
  assert.deepEqual(fake.changes, []);
});

test("an unknown enable outcome is followed by disable; failed disable is explicit", async () => {
  for (const failState of ["Enabled", "Disabled"]) {
    const fake = transport({ httpStatus: 403 });
    await assert.rejects(runTrigger({
      c: fixture(), kind: "control-negative", request: async args => {
        const result = await fake.request(args);
        if (args.method === "put" && args.body.properties.state === failState) {
          throw new Error(`${failState} write outcome unknown; inspect existing trigger`);
        }
        return result;
      },
    }), /write outcome unknown/);
    assert.deepEqual(fake.changes, ["Enabled", "Disabled"]);
  }
});
