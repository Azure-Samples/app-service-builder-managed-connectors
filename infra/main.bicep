targetScope = 'resourceGroup'

@description('Unique lowercase letters/digits for this disposable test. Do not reuse another experiment.')
@minLength(6)
@maxLength(16)
param run string

@description('Region enabled for both Builder Node24 activation and Connector Namespace.')
param location string = 'westus2'

var tags = {
  sample: 'app-service-builder-managed-connectors'
  experiment: run
}

resource appIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: 'id-bld-app-${run}'
  location: location
  tags: tags
}

resource triggerIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: 'id-bld-trigger-${run}'
  location: location
  tags: tags
}

resource negativeIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: 'id-bld-negative-${run}'
  location: location
  tags: tags
}

resource namespace 'Microsoft.Web/connectorGateways@2026-05-01-preview' = {
  name: 'cn-builder-${run}'
  location: location
  tags: tags
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${triggerIdentity.id}': {}
      '${negativeIdentity.id}': {}
    }
  }
}

resource app 'Microsoft.Web/builderApps@2026-09-01-preview' = {
  name: 'bld-connectors-${run}'
  location: location
  tags: tags
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${appIdentity.id}': {}
    }
  }
  properties: {}
}

output configuration object = {
  subscriptionId: subscription().subscriptionId
  tenantId: tenant().tenantId
  resourceGroup: resourceGroup().name
  location: location
  run: run
  appName: app.name
  appResourceId: app.id
  namespaceResourceId: namespace.id
  appIdentity: {
    id: appIdentity.id
    clientId: appIdentity.properties.clientId
    principalId: appIdentity.properties.principalId
  }
  triggerIdentity: {
    id: triggerIdentity.id
    clientId: triggerIdentity.properties.clientId
    principalId: triggerIdentity.properties.principalId
  }
  negativeIdentity: {
    id: negativeIdentity.id
    clientId: negativeIdentity.properties.clientId
    principalId: negativeIdentity.properties.principalId
  }
}
