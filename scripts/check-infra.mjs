import assert from "node:assert/strict";

let input = "";
for await (const chunk of process.stdin) input += chunk;
const template = JSON.parse(input);
const resources = template.resources;
assert.equal(resources.length, 5);
assert.equal(resources.filter(r => r.type === "Microsoft.ManagedIdentity/userAssignedIdentities").length, 3);
const namespace = resources.find(r => r.type === "Microsoft.Web/connectorGateways");
const app = resources.find(r => r.type === "Microsoft.Web/builderApps");
assert.equal(Object.keys(namespace.identity.userAssignedIdentities).length, 2);
assert.equal(Object.keys(app.identity.userAssignedIdentities).length, 1);
assert.deepEqual(app.properties, {});
assert.equal(template.outputs.configuration.type, "object");
assert(!JSON.stringify(template).includes("roleAssignments"));
console.log("Compiled infrastructure has only the five expected resources, no source, secrets or Azure RBAC grants.");
