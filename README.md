# Homebridge Prometheus Sensor

This Homebridge dynamic platform exposes Prometheus or Grafana Mimir metrics as
HomeKit sensors: carbon dioxide (`rco2`), ambient light (`input_power`), and
relative humidity (`humidity`). Both backends use the Prometheus-compatible
`/api/v1/query` endpoint. The humidity metric must return a percentage between
0 and 100.

## Configuration

Add one platform entry to your Homebridge configuration:

```json
{
  "platform": "PrometheusSensorPlugin2",
  "name": "Prometheus sensors",
  "url": "https://prometheus.example.com"
}
```

The URL should be the base URL of your Prometheus or Mimir server. The plugin queries
`/api/v1/query` for each of the metrics above. The HomeKit humidity sensor uses
the `humidity` metric directly, in percent.

### Authentication

Authentication is optional. Configure either basic authentication using both
`username` and `password`, or a `bearerToken`; do not configure both methods.
For multi-tenant Mimir, set `mimirTenantId` to send the `X-Scope-OrgID` header.
That tenant header is optional and can be used alongside either authentication
method. Use an HTTPS URL when credentials or tokens are sent over an untrusted
network.

Example for a Mimir tenant using a bearer token:

```json
{
  "platform": "PrometheusSensorPlugin2",
  "name": "Mimir sensors",
  "url": "https://mimir.example.com/prometheus",
  "bearerToken": "your-token",
  "mimirTenantId": "your-tenant"
}
```

For basic authentication, replace `bearerToken` with `username` and `password`.

## Development

Run the unit tests with `npm test`.
