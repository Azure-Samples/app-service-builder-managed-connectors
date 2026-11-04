import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const guid = (value) => typeof value === "string" &&
  /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(value) &&
  value !== "00000000-0000-0000-0000-000000000000";
function requireValue(condition, message) {
  if (!condition) throw new Error(message);
}
function experiment(run) {
  requireValue(typeof run === "string" && /^[a-z0-9]{6,16}$/.test(run), "Use a unique 6-16 character lowercase alphanumeric run.");
  return `[builder-connector-${run}]`;
}
function context(c) {
  experiment(c.run);
  for (const key of ["subscriptionId", "tenantId", "apiClientId", "apiServicePrincipalId", "roleId"]) {
    requireValue(guid(c[key]), `Invalid ${key}.`);
  }
  requireValue(c.resourceGroup === `rg-builder-connectors-${c.run}`, "Resource group must be this experiment's isolated group.");
  const scope = `/subscriptions/${c.subscriptionId}/resourceGroups/${c.resourceGroup}/providers`;
  requireValue(c.appResourceId === `${scope}/Microsoft.Web/builderApps/bld-connectors-${c.run}`, "Unexpected Builder app.");
  requireValue(c.namespaceResourceId === `${scope}/Microsoft.Web/connectorGateways/cn-builder-${c.run}`, "Unexpected namespace.");
  const principals = [];
  for (const kind of ["app", "trigger", "negative"]) {
    const identity = c[`${kind}Identity`];
    requireValue(identity && guid(identity.clientId) && guid(identity.principalId), `Invalid ${kind} identity.`);
    requireValue(identity.id === `${scope}/Microsoft.ManagedIdentity/userAssignedIdentities/id-bld-${kind}-${c.run}`, `Unexpected ${kind} identity resource.`);
    principals.push(identity.principalId);
  }
  requireValue(new Set(principals).size === 3, "Use three distinct managed identities.");
  requireValue(typeof c.location === "string" && /^[a-z0-9]+$/.test(c.location), "Invalid region.");
}

export function registration(run, roleId, serviceTree = "") {
  experiment(run);
  requireValue(guid(roleId), "Generate a nonzero application-role GUID.");
  requireValue(!serviceTree || guid(serviceTree), "Invalid Service Tree reference.");
  return {
    displayName: `Builder connector receiver ${run}`,
    signInAudience: "AzureADMyOrg",
    ...(serviceTree ? { serviceManagementReference: serviceTree } : {}),
    api: { requestedAccessTokenVersion: 2, oauth2PermissionScopes: [] },
    optionalClaims: { accessToken: [{ name: "idtyp", source: null, essential: false, additionalProperties: [] }] },
    appRoles: [{
      allowedMemberTypes: ["Application"], description: "Invoke this isolated Builder connector receiver.",
      displayName: "Invoke Builder connector receiver", id: roleId, isEnabled: true, value: "BuilderConnector.Invoke",
    }],
    requiredResourceAccess: [],
  };
}

export function prepare(c) {
  context(c);
  const policy = (identity) => ({
    location: c.location,
    properties: { principal: { type: "ActiveDirectory", identity: { tenantId: c.tenantId, objectId: identity.principalId } } },
  });
  const grant = (identity) => ({ principalId: identity.principalId, resourceId: c.apiServicePrincipalId, appRoleId: c.roleId });
  return {
    "auth-policy": { properties: {
      mode: "required", primaryBrowserProvider: "entraId",
      entraId: {
        enabled: true, applicationMode: "customer",
        customerApplication: {
          clientId: c.apiClientId, homeTenantId: c.tenantId, signInMode: "singleTenant",
          workloadIdentityResourceId: c.appIdentity.id, allowedAudiences: [c.apiClientId],
        },
        tenantIds: [c.tenantId], objectIds: [c.triggerIdentity.principalId],
      },
    } },
    connection: { location: c.location, properties: { connectorName: "office365" } },
    "app-policy": policy(c.appIdentity),
    "trigger-policy": policy(c.triggerIdentity),
    "trigger-grant": grant(c.triggerIdentity),
    "negative-grant": grant(c.negativeIdentity),
    scaling: { properties: { scaling: { components: [
      { name: "receiver", minReplicas: 1, maxReplicas: 2, httpEnabled: true },
    ] } } },
  };
}

export function runtime(c) {
  context(c);
  const origin = new URL(c.appOrigin);
  requireValue(origin.protocol === "https:" && origin.origin === c.appOrigin &&
    !origin.username && !origin.password, "Use the actual HTTPS Builder origin without path or trailing slash.");
  const connection = new URL(c.connectionRuntimeUrl);
  requireValue(connection.protocol === "https:" && !connection.username && !connection.password &&
    !connection.search && !connection.hash, "Use the returned HTTPS connectionRuntimeUrl, not a credential-bearing URL.");
  const issuer = `https://login.microsoftonline.com/${c.tenantId}/v2.0`;
  requireValue(c.entraSetup?.federatedCredentialIssuer === issuer &&
    c.entraSetup.federatedCredentialSubject === c.appIdentity.principalId &&
    c.entraSetup.federatedCredentialAudience === "api://AzureADTokenExchange",
  "Builder-returned federation does not match the selected tenant and app identity; stop rather than invent values.");
  const notify = (identity, audience) => ({
    callbackUrl: `${origin.origin}/api/webhook`, httpMethod: "Post",
    authentication: { type: "ManagedServiceIdentity", identity: identity.id, audience },
  });
  const audience = `api://${c.apiClientId}`;
  const control = (identity, resource) => ({ properties: {
    description: "Isolated authentication-only control; no mailbox connection",
    type: "Recurrence", recurrence: { frequency: "Minute", interval: 1 }, state: "Disabled",
    notificationDetails: { ...notify(identity, resource), body: { body: { value: [] } } },
  } });
  return {
    federation: {
      name: `builder-app-${c.run}`, issuer: c.entraSetup.federatedCredentialIssuer,
      subject: c.entraSetup.federatedCredentialSubject, audiences: [c.entraSetup.federatedCredentialAudience],
    },
    redirect: { web: { redirectUris: [`${origin.origin}/.auth/login/aad/callback`] } },
    variables: { properties: { versionConfiguration: { variables: [
      { name: "AZURE_CLIENT_ID", value: c.appIdentity.clientId },
      { name: "OFFICE365_CONNECTION_RUNTIME_URL", value: c.connectionRuntimeUrl },
      { name: "TEST_SUBJECT_PREFIX", value: experiment(c.run) },
    ] } } },
    "mail-trigger": { properties: {
      description: "Two-message experiment; prefix-filtered Outlook event only",
      connectionDetails: { connectorName: "office365", connectionName: "outlook-test" },
      operationName: "OnNewEmailV3",
      parameters: [{ name: "folderPath", value: "Inbox" }, { name: "subjectFilter", value: experiment(c.run) }],
      settings: { disableSplitOn: true }, state: "Disabled",
      notificationDetails: notify(c.triggerIdentity, audience),
    } },
    "control-negative": control(c.negativeIdentity, audience),
    "control-wrong-audience": control(c.triggerIdentity, "https://management.azure.com/"),
    "control-allowed": control(c.triggerIdentity, audience),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [phase, input, output, serviceTree] = process.argv.slice(2);
  if (phase === "registration") {
    console.log(JSON.stringify(registration(input, output, serviceTree), null, 2));
  } else {
    requireValue(["prepare", "runtime"].includes(phase) && input && output,
      "Usage: node scripts/config.mjs registration RUN ROLE_GUID [SERVICE_TREE_GUID], or prepare|runtime CONTEXT_JSON OUTPUT_DIRECTORY");
    const files = (phase === "prepare" ? prepare : runtime)(JSON.parse(await readFile(input, "utf8")));
    await mkdir(output, { recursive: true, mode: 0o700 });
    for (const [name, body] of Object.entries(files)) {
      await writeFile(resolve(output, `${name}.json`), `${JSON.stringify(body, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    }
    console.log(`Rendered ${Object.keys(files).length} local request files. No cloud requests made.`);
  }
}
