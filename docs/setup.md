# Configure a protected Outlook callback

Create an isolated Connector Namespace and protect its Builder receiver before deploying code.
Run commands from the repository root in one Bash session.
Use Azure CLI/Bicep for resources and directory setup, then Builder Portal for GitHub source and deployment.

## Prerequisites

Use Bash, Azure CLI with Bicep, Node.js 24, Python 3 and `jq`.
Fork this repository to your GitHub account, clone the fork and run `npm ci`.
Keep the root `builder.yaml`; push changes before connecting GitHub source.
`npm test` builds and runs only loopback/fake-service tests.
`npm run test:infra` compiles the template and checks its resource inventory without contacting ARM.
CI runs those checks and the production dependency audit without Azure credentials.

Obtain App Service Builder preview access, Node24 activation and Connector Namespace availability in your selected region.
Confirm current West US 2 availability for your subscription before using the default location.
The operator needs resource deployment permissions on the new group, permission to create the group, and separate directory permission to create an owned registration/service principal and assign its application role to the two identities.
Grant no Azure RBAC or Microsoft Graph runtime permissions to the receiver or its identities.
Mailbox licensing, owner OAuth consent and any tenant administrator consent are separate prerequisites.

## 1. Provision an isolated experiment

Select your authorized subscription and tenant:

```bash
export SUBSCRIPTION_ID="<your-subscription-guid>"
export TENANT_ID="<your-organizational-tenant-guid>"
export LOCATION="westus2"
export RUN="$(node -p "require('node:crypto').randomBytes(4).toString('hex')")"
export RG="rg-builder-connectors-$RUN"
az login --tenant "$TENANT_ID"
az account set --subscription "$SUBSCRIPTION_ID"
az account show --query '{subscription:id,tenant:tenantId,state:state}'
test "$(az account show --query tenantId -o tsv)" = "$TENANT_ID" || exit 1
test "$(az group exists --subscription "$SUBSCRIPTION_ID" --name "$RG")" = false || exit 1
mkdir -p .local
chmod 700 .local
az bicep build --file infra/main.bicep --stdout > .local/template.json
```

`.local/` is ignored and contains private, experiment-specific settings and receipts.
Do not commit it, `.azure/`, tokens, consent links, message IDs, mailbox contents or real identity values.
Read provider registration and regional availability with `az provider show` for `Microsoft.Web` and `Microsoft.ManagedIdentity`.
An error from the separate `Microsoft.Quota` API does not prove that the namespace provider needs registration.
Do not register providers or request quota increases without approval.
Confirm capacity for one Builder app, two replicas, one build, three identities, one namespace, one connection and two trigger configurations.
Use service-specific limits or your preview contact when a generic quota endpoint cannot report these resources.

The template creates three user-assigned managed identities, a namespace with both callback identities attached, and an empty Builder app with only the outbound app identity.
It does not connect source, build code, authenticate Outlook, create triggers or grant Azure RBAC.
Bicep can emit BCP081 for the preview namespace and Builder types: compilation cannot validate those property schemas.
Review ARM validation and what-if before provisioning:

```bash
az group create --subscription "$SUBSCRIPTION_ID" --name "$RG" --location "$LOCATION"
az deployment group validate --subscription "$SUBSCRIPTION_ID" --resource-group "$RG" \
  --template-file infra/main.bicep --parameters run="$RUN" location="$LOCATION"
az deployment group what-if --subscription "$SUBSCRIPTION_ID" --resource-group "$RG" \
  --template-file infra/main.bicep --parameters run="$RUN" location="$LOCATION"
az deployment group create --subscription "$SUBSCRIPTION_ID" --resource-group "$RG" \
  --name connector-sample --template-file infra/main.bicep --parameters run="$RUN" location="$LOCATION"
az deployment group show --subscription "$SUBSCRIPTION_ID" --resource-group "$RG" \
  --name connector-sample --query properties.outputs.configuration.value > .local/context.json
```

Wait for terminal success and inspect errors.
Stop on an unknown write outcome and reconcile that operation/resource before retrying.
Do not rerun this creation template over a configured app: full PUT can replace source and desired settings.
The namespace receives both identities at creation because preview identity updates can be rejected.

## 2. Configure the receiver API before connecting source

Generate one role ID, retain it for this experiment, and create a single-tenant registration:

```bash
export ROLE_ID="$(node -p "require('node:crypto').randomUUID()")"
# Set only if your tenant requires its approved Service Tree ownership reference.
export SERVICE_TREE_REFERENCE=""
node scripts/config.mjs registration "$RUN" "$ROLE_ID" "$SERVICE_TREE_REFERENCE" > .local/registration.json
az rest --method post --url https://graph.microsoft.com/v1.0/applications \
  --body @.local/registration.json > .local/application.json
export APP_OBJECT_ID="$(jq -r .id .local/application.json)"
export API_CLIENT_ID="$(jq -r .appId .local/application.json)"
jq -n --arg uri "api://$API_CLIENT_ID" '{identifierUris:[$uri]}' > .local/identifier-uri.json
az rest --method patch --url "https://graph.microsoft.com/v1.0/applications/$APP_OBJECT_ID" \
  --body @.local/identifier-uri.json
jq -n --arg id "$API_CLIENT_ID" '{appId:$id,appRoleAssignmentRequired:true}' > .local/sp-request.json
az rest --method post --url https://graph.microsoft.com/v1.0/servicePrincipals \
  --body @.local/sp-request.json > .local/service-principal.json
export API_SP_ID="$(jq -r .id .local/service-principal.json)"
jq --arg client "$API_CLIENT_ID" --arg sp "$API_SP_ID" --arg role "$ROLE_ID" \
  '. + {apiClientId:$client,apiServicePrincipalId:$sp,roleId:$role}' .local/context.json > .local/context.next.json
mv .local/context.next.json .local/context.json
node scripts/config.mjs prepare .local/context.json .local/prepare
```

If Graph returns `ServiceTreeValueMissing`, reconcile that no app was created, obtain your tenant's approved reference, then render a new request.
Do not copy an unrelated service's reference or add a secret to bypass policy.
The generator requests API v2 tokens, optional access-token `idtyp`, one application-only `BuilderConnector.Invoke` role and no external API permissions.
The resource service principal requires assignment.
Assign the same role directly to the namespace sender and negative-control identities; only the sender will be allowed by Builder:

```bash
for body in trigger-grant negative-grant; do
  az rest --method post --url "https://graph.microsoft.com/v1.0/servicePrincipals/$API_SP_ID/appRoleAssignedTo" \
    --body "@.local/prepare/$body.json"
done
export APP_ID="$(jq -r .appResourceId .local/context.json)"
export NS_ID="$(jq -r .namespaceResourceId .local/context.json)"
export APP_URL="https://management.azure.com$APP_ID?api-version=2026-09-01-preview"
export NS_URL="https://management.azure.com$NS_ID"
az rest --method put --url "https://management.azure.com$APP_ID/authConfigs/current?api-version=2026-09-01-preview" \
  --body @.local/prepare/auth-policy.json
az rest --method get --url "https://management.azure.com$APP_ID/authConfigs/current?api-version=2026-09-01-preview" \
  > .local/auth-readback.json
```

Verify **required** customer-Entra authentication, exactly the API client GUID in `allowedAudiences`, the selected tenant, and only the trigger identity's **principal/object ID** in `objectIds`.
No alternate provider or email rule is configured.
Do not use the identity client ID where an object ID is required.
Builder's role-presence check establishes app-token shape; it does not enforce a particular role value.
The exact tenant/object allowlist is this receiver's sender-authorization boundary.

## 3. Prepare the connection and returned federation

The following creates an **unconnected** Outlook connection and exactly two connection policies:

```bash
export CONN_URL="$NS_URL/connections/outlook-test?api-version=2026-05-01-preview"
az rest --method put --url "$CONN_URL" --body @.local/prepare/connection.json
for kind in app trigger; do
  principal="$(jq -r ".${kind}Identity.principalId" .local/context.json)"
  az rest --method put --url "$NS_URL/connections/outlook-test/accessPolicies/$principal?api-version=2026-05-01-preview" \
    --body "@.local/prepare/$kind-policy.json"
done
az rest --method get --url "$CONN_URL" \
  --query '{connectionRuntimeUrl:properties.connectionRuntimeUrl}' > .local/connection.json
jq --slurpfile auth .local/auth-readback.json --slurpfile conn .local/connection.json \
  '. + {appOrigin:($auth[0].properties.entraCallbackUrl|split("/.auth/login/aad/callback")[0]),
         entraSetup:$auth[0].properties.entraSetup,connectionRuntimeUrl:$conn[0].connectionRuntimeUrl}' \
  .local/context.json > .local/context.next.json
mv .local/context.next.json .local/context.json
node scripts/config.mjs runtime .local/context.json .local/runtime
az rest --method patch --url "https://graph.microsoft.com/v1.0/applications/$APP_OBJECT_ID" \
  --body @.local/runtime/redirect.json
az rest --method post --url "https://graph.microsoft.com/v1.0/applications/$APP_OBJECT_ID/federatedIdentityCredentials" \
  --body @.local/runtime/federation.json
az rest --method patch --url "$APP_URL" --body @.local/runtime/variables.json
az rest --method patch --url "$APP_URL" --body @.local/prepare/scaling.json
```

Use the actual Builder-returned redirect and `entraSetup` federation values.
The generator stops if they do not match the selected tenant/app identity; never invent issuer/subject values.
Read back the API registration, both role grants, federation and both policies.
The negative identity gets no connection policy.
No policy limits OAuth to flagging alone; the deliberately narrow application behavior is not an IAM permission boundary.

## 4. Connect your fork and deploy in Builder Portal

The **empty app already exists** and required auth is configured.
Do not start a second app through Portal **Create** or deploy this receiver first and add protection later.

1. Open [Builder Portal](https://builder.appservice.azure.com/), select your verified directory/subscription, and open `bld-connectors-<run>`.
2. In **Authentication**, verify required customer-Entra settings above.
   In **Identity**, verify only the app UAMI; in **Variables**, verify the three desired variables.
3. Open **Settings → Source Control**, sign in to the intended GitHub account and select **your fork**, branch and repository root.
   Review the GitHub App publisher and grant installation access to that fork if needed.
4. Keep automatic deployment **off** and select **Save**, not **Save and deploy**, until settings are verified.
   Do not replace the root manifest.
5. Explicitly deploy the connected source.
   Wait for terminal deployment success, then verify the active version and exact source commit in **Versions**.
   A successful source save or build is not Node24 activation.

Keep the receiver's minimum 1 / maximum 2 HTTP scaling policy for this experiment.
The manifest has no public health-path exception; default edge reachability401 is not process health proof.
The allowed empty-batch callback below establishes protected receiver execution.
Saving variables does not change the active version until deployment.
Read `authConfigs/current` again and wait for `propagationPending: false` and matching `revision` / `appliedRevision` before testing.

## 5. Verify authentication without mailbox effects

Use the returned app origin, no browser cookies and no redirect following:

```bash
export ORIGIN="$(jq -r .appOrigin .local/context.json)"
curl -i -X POST -H 'Accept: application/json' "$ORIGIN/api/webhook"
curl -i -X POST -H 'Accept: application/json' -H 'Authorization: Bearer malformed' "$ORIGIN/api/webhook"
curl -i -X POST -H 'Accept: application/json' -H 'X-MS-CLIENT-PRINCIPAL-ID: spoofed' "$ORIGIN/api/webhook"
az rest --method put --url "$NS_URL/triggerConfigs/auth-control?api-version=2026-05-01-preview" \
  --body @.local/runtime/control-negative.json
node scripts/run-trigger.mjs .local/context.json control-negative
node scripts/run-trigger.mjs .local/context.json control-wrong-audience
node scripts/run-trigger.mjs .local/context.json control-allowed
```

All three direct POSTs must return 401, not a login redirect.
The bounded controls expect 403 for a valid same-API-role wrong principal, 401 for the allowed principal requesting the wrong ARM resource audience, then 200 with received 0 / flagged 0 for the allowed API audience.
A 401 in the wrong-principal case is **not** an authorization pass.
The ARM audience is used only for that negative control, never for the mail trigger.
The runner uses full-config state PUT, disables in `finally` and confirms Disabled.
Keep the runner open; forced process termination/network loss can prevent cleanup, so independently read back state after any interruption.
If role claims are stale, leave triggers disabled and allow MI token-cache propagation before a deliberate retry; do not create replacement identities.

## 6. Connect the owner-approved Outlook account

Have the mailbox owner approve the exact account, actual OAuth permissions, two synthetic messages and the single flag effect.
Prefer a dedicated test mailbox; never inspect or modify unrelated mail.
Consent may be broader than flagging and may require tenant administration; catalog scopes and connection policies are not a consent review.
Open this documented connection flow in the operator's **native browser**, where the owner handles sign-in/MFA and reviews permissions:

```bash
python3 - <<'PY'
import json, os, subprocess, webbrowser
base = os.environ["NS_URL"] + "/connections/outlook-test"
api = "?api-version=2026-05-01-preview"
creator = json.loads(subprocess.check_output(
    ["az","rest","--method","get","--url",base+api,
     "--query","properties.createdBy","-o","json"], text=True))
body = {"parameters":[{"objectId":creator["objectId"],"tenantId":creator["tenantId"],
                       "redirectUrl":"https://microsoft.com","parameterName":"token"}]}
link = subprocess.check_output(
    ["az","rest","--method","post","--url",base+"/listConsentLinks"+api,
     "--body",json.dumps(body),"--query","value[0].link","-o","tsv"], text=True).strip()
if not webbrowser.open(link):
    raise SystemExit("Native browser did not open; do not regenerate or publish the consent link.")
PY
az rest --method get --url "$CONN_URL" --query '{status:properties.overallStatus,user:properties.authenticatedUser}'
```

Do not print, save, copy into source or publish the temporary consent URL.
Wait for owner completion; confirm `Connected` and the authenticated user matches the intended mailbox.
Do not infer completion from opening the browser or silently switch accounts.
If already Connected to the correct account, do not generate another link.

## 7. Send exactly two test messages

Create the primary event trigger Disabled, then start a bounded five-minute window:

```bash
az rest --method put --url "$NS_URL/triggerConfigs/mail-test?api-version=2026-05-01-preview" \
  --body @.local/runtime/mail-trigger.json
node scripts/run-trigger.mjs .local/context.json mail-trigger 300
```

Wait for **Enabled** in the terminal.
From the approved mailbox, manually send one unflagged message to that same mailbox with subject `[builder-connector-<run>] validation` and one unflagged control with subject `connector control <run>`.
Replace `<run>` with this experiment's `RUN`; use harmless text, no attachments and no sensitive content.
The app sends no mail; it uses `ManagedIdentityTokenProvider(appClientId)` and `Office365Client.flagAsync` only for matching message IDs.
Do not resend if delivery or the send outcome is unclear.

Expect one namespace callback 200 with received 1 / flagged 1 and an independently observed matching email flag.
The control remains unflagged.
The handler validates the full batch before effects, filters again by prefix and returns 400/413 for invalid/oversized input or 502 when an SDK action fails.
Retries may repeat an already completed flag after partial batch failure; this is not exactly-once processing.
Inspect only the two approved messages and sanitized counts/statuses, never raw request headers, JWTs, consent links or full notification bodies.
The runner disables after its first completed run and reports a non-200 or wrong counts as a failure, not success.
If no event arrives, it disables at the deadline; inspect that existing run/connection rather than sending more messages.

Keep all triggers Disabled outside the attended test.
Stop at 30 minutes total enabled time, twenty callbacks, ten flag attempts or two test messages, whichever comes first.
The default three two-minute controls plus one five-minute mail window stay below the time limit.

## Clean up resources

Deletion is destructive: confirm the group contains only the resources you just created.
Retain your private context/receipts until absence is verified.
Do not delete the shared Office365 enterprise application or any pre-existing resource.
Deleting Azure resources does not delete the receiver's directory registration.
Message deletion or reverting a flag requires separate owner approval; otherwise preserve both messages.

```bash
# Inspect before deleting; both trigger states must be Disabled.
az resource list --subscription "$SUBSCRIPTION_ID" --resource-group "$RG" --query '[].{name:name,type:type}'
az rest --method get --url "$NS_URL/triggerConfigs?api-version=2026-05-01-preview" \
  --query 'value[].{name:name,state:properties.state}'
# If a trigger is Enabled, PUT its saved Disabled config first; never abandon it.
for name in mail-test auth-control; do
  az rest --method delete --url "$NS_URL/triggerConfigs/$name?api-version=2026-05-01-preview"
done
for kind in app trigger; do
  principal="$(jq -r ".${kind}Identity.principalId" .local/context.json)"
  az rest --method delete --url "$NS_URL/connections/outlook-test/accessPolicies/$principal?api-version=2026-05-01-preview"
done
az rest --method delete --url "$CONN_URL"
az group delete --subscription "$SUBSCRIPTION_ID" --name "$RG" --yes
az rest --method delete --url "https://graph.microsoft.com/v1.0/servicePrincipals/$API_SP_ID"
az rest --method delete --url "https://graph.microsoft.com/v1.0/applications/$APP_OBJECT_ID"
az group exists --subscription "$SUBSCRIPTION_ID" --name "$RG"
az rest --method get --url "https://graph.microsoft.com/v1.0/applications?\$filter=appId%20eq%20%27$API_CLIENT_ID%27&\$select=id" --query value
az rest --method get --url "https://graph.microsoft.com/v1.0/servicePrincipals?\$filter=appId%20eq%20%27$API_CLIENT_ID%27&\$select=id" --query value
for kind in app trigger negative; do
  principal="$(jq -r ".${kind}Identity.principalId" .local/context.json)"
  az rest --method get --url "https://graph.microsoft.com/v1.0/servicePrincipals?\$filter=id%20eq%20%27$principal%27&\$select=id" --query value
done
```

Expect `false`, then five empty arrays.
If UAMI deletion is still propagating, wait and repeat only those absence reads.
Normal directory deletion is sufficient; do not permanently purge unrelated recycle-bin objects.
For partial setup or interrupted cleanup, inspect the exact remaining IDs and delete only confirmed owned resources; a404 is not a reason to provision replacements.

## Costs and failure boundaries

Builder's initial preview offer and external Connector Namespace billing are separate.
Connector actions, polls, callbacks/retries and retained run data may incur charges, including failed runs.
Check current [Connector Namespace billing](https://learn.microsoft.com/azure/connector-namespace/connector-namespace-overview) and [connector rates](https://azure.microsoft.com/en-us/pricing/details/logic-apps/) before approving an experiment; mailbox licensing is separate.
No VM, App Service plan, monitoring workspace, database or extra token-minting compute is required.
This example creates no Azure role assignments.

| Symptom | Safe check |
|---|---|
| Node build succeeds but activation fails | Check terminal deployment/active version and target Node24 support; do not disable auth or silently choose another runtime/region. |
| Callback401 | Check API v2/idtyp/application-role setup, tenant issuer and GUID token audience. Do not copy upstream Easy Auth settings. |
| Wrong-principal control401 instead of403 | Check direct role assignment and MI cache propagation; it has not proven the exact-object allowlist yet. |
| Connection Error/Unauthenticated | Complete owner-reviewed consent and verify account/status; do not broaden connection policies. |
| Callback502 | The flag action failed; check the app identity's exact connection policy and correct runtime URL, not namespace-wide Contributor. |
| Namespace lifecycle POST 404 | Use the saved full-config PUT state contract, then read back state. |

## Provenance

This sample adapts
[Azure-Samples/app-service-managed-connectors](https://github.com/Azure-Samples/app-service-managed-connectors/tree/49055ca720daab2d7378aeb617cdfae00c28b443).
Keep private platform source, cloud receipts and credentials out of this repository.
The adaptation retains that upstream's [MIT license](../LICENSE.md).
The pinned SDK remains `@azure/connectors@0.2.0-preview`; newer SDK contracts are not interchangeable without review.
