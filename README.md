# Homebridge Prometheus Sensor

This Homebridge dynamic platform exposes Prometheus or Grafana Mimir queries as
HomeKit carbon dioxide, humidity, temperature, or power sensors. Power is
displayed as a light sensor. Both backends use the Prometheus-compatible
`/api/v1/query` endpoint.

## Configuration

Configure sensors in the Homebridge UI, or add one platform entry to your
Homebridge configuration:

```json
{
  "platform": "PrometheusSensorPlugin2",
  "name": "Prometheus sensors",
  "url": "https://prometheus.example.com",
  "sensors": [
    { "id": "living-co2", "name": "Living room CO2", "type": "co2", "query": "rco2{room=\"living\"}" },
    { "id": "bedroom-humidity", "name": "Bedroom humidity", "type": "humidity", "query": "humidity{room=\"bedroom\"}" },
    { "id": "living-temperature", "name": "Living room temperature", "type": "temperature", "query": "temperature_celsius{room=\"living\"}" },
    { "id": "solar-power", "name": "Solar power", "type": "power", "query": "input_power" }
  ]
}
```

All sensors share the URL and authentication settings, but each has its own
name, type, and PromQL query. Each query must return an instant vector; if it
returns multiple series, only the first is used. Humidity must be between 0 and
100 percent, temperature is in Celsius, and CO2 is in ppm. Power is exposed as
a light level and values below 0.0001 are clamped to 0.0001.

Each sensor's `id` must be unique and stable: changing it creates a new HomeKit
accessory. Removing a sensor removes its accessory. A sensor list is required;
configurations from earlier versions must be updated, and their previous
combined accessory is removed when the new sensors are registered.

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
  "mimirTenantId": "your-tenant",
  "sensors": [
    { "id": "humidity", "name": "Humidity", "type": "humidity", "query": "humidity" }
  ]
}
```

For basic authentication, replace `bearerToken` with `username` and `password`.

## Development

Run the unit tests with `npm test`.
