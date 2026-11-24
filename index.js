const axios = require('axios');

const PLUGIN_NAME = 'homebridge-prometheus-sensor2';
const PLATFORM_NAME = 'PrometheusSensorPlugin2';
const SENSOR_TYPES = {
	co2: ['CarbonDioxideSensor', 'CarbonDioxideLevel'],
	humidity: ['HumiditySensor', 'CurrentRelativeHumidity'],
	power: ['LightSensor', 'CurrentAmbientLightLevel'],
	temperature: ['TemperatureSensor', 'CurrentTemperature'],
};

module.exports = (api) => {
	api.registerPlatform(PLUGIN_NAME, PLATFORM_NAME, PrometheusSensorPlatform, true);
};

class PrometheusSensorPlatform {

	constructor(log, config, api) {
		this.log = log;
		this.config = config;
		this.api = api;
		this.name = config.name;
		this.url = typeof config.url === 'string' ? config.url.trim().replace(/\/+$/, '') : '';
		this.configurationError = this.validateUrl(this.url);
		try {
			this.authConfig = this.createAuthConfig(config);
			this.sensors = this.validateSensors(config.sensors);
		} catch (error) {
			this.configurationError = this.configurationError || error;
		}
		this.cachedAccessories = [];

		if (this.configurationError) {
			this.log.error(`Invalid platform configuration: ${this.configurationError.message}`);
		}
		api.on('didFinishLaunching', () => this.didFinishLaunching());
	}

	configureAccessory(accessory) {
		this.cachedAccessories.push(accessory);
	}

	didFinishLaunching() {
		if (this.configurationError) {
			return;
		}

		const Service = this.api.hap.Service;
		const Characteristic = this.api.hap.Characteristic;
		const activeUUIDs = new Set();
		for (const sensor of this.sensors) {
			const uuid = this.api.hap.uuid.generate(`${PLUGIN_NAME}:${sensor.id}`);
			activeUUIDs.add(uuid);
			const accessory = this.cachedAccessories.find((cached) => cached.UUID === uuid)
				|| new this.api.platformAccessory(sensor.name, uuid);
			const [serviceName, characteristicName] = SENSOR_TYPES[sensor.type];
			accessory.displayName = sensor.name;

			for (const [otherServiceName] of Object.values(SENSOR_TYPES)) {
				if (otherServiceName !== serviceName) {
					const oldService = accessory.getService(Service[otherServiceName]);
					if (oldService) accessory.removeService(oldService);
				}
			}
			const service = this.addService(accessory, Service[serviceName], sensor.name);
			service.setCharacteristic(Characteristic.Name, sensor.name);
			service
				.getCharacteristic(Characteristic[characteristicName])
				.onGet(() => this.readSensor(sensor));

			const information = accessory.getService(Service.AccessoryInformation)
				|| accessory.addService(Service.AccessoryInformation);
			information
				.setCharacteristic(Characteristic.Manufacturer, 'Prometheus')
				.setCharacteristic(Characteristic.Model, 'Prometheus Sensor');
			if (!this.cachedAccessories.includes(accessory)) {
				this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
			}
		}
		const staleAccessories = this.cachedAccessories.filter((cached) => !activeUUIDs.has(cached.UUID));
		if (staleAccessories.length) {
			this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, staleAccessories);
		}
	}

	addService(accessory, serviceType, name) {
		return accessory.getService(serviceType) || accessory.addService(serviceType, name);
	}

	readSensor(sensor) {
		this.log.debug(`Reading sensor "${sensor.name}"`);
		return this.queryPrometheus(sensor.query).then((value) => {
			if (sensor.type === 'humidity' && (value < 0 || value > 100)) {
				const error = new Error(`Prometheus humidity value must be between 0 and 100; received ${value}`);
				this.log.error(`Failed to read humidity metric: ${error.message}`);
				throw error;
			}
			return sensor.type === 'power' ? Math.max(value, 0.0001) : value;
		});
	}

	validateSensors(sensors) {
		if (!Array.isArray(sensors) || sensors.length === 0) {
			throw new Error('Configure at least one sensor in the sensors list');
		}
		const ids = new Set();
		return sensors.map((sensor) => {
			if (!sensor || typeof sensor !== 'object'
				|| !['id', 'name', 'query'].every((key) => typeof sensor[key] === 'string' && sensor[key].trim())) {
				throw new Error('Each sensor requires a non-empty id, name, and query');
			}
			if (!Object.prototype.hasOwnProperty.call(SENSOR_TYPES, sensor.type)) {
				throw new Error(`Unsupported sensor type "${sensor.type}"`);
			}
			const id = sensor.id.trim();
			if (ids.has(id)) throw new Error(`Duplicate sensor id "${id}"`);
			ids.add(id);
			return { ...sensor, id };
		});
	}

	queryPrometheus(metric) {
		const requestConfig = {
			params: { query: metric },
			...this.authConfig,
		};
		return axios.get(`${this.url}/api/v1/query`, requestConfig)
			.then((response) => {
				const result = response.data
					&& response.data.data
					&& response.data.data.result
					&& response.data.data.result[0];
				if (!result || !result.value || result.value.length < 2) {
					throw new Error(`Prometheus returned no value for metric "${metric}"`);
				}

				const value = Number(result.value[1]);
				if (!Number.isFinite(value)) {
					throw new Error(`Prometheus returned a non-numeric value for metric "${metric}"`);
				}
				return value;
			})
			.catch((error) => {
				this.log.error(`Failed to query Prometheus metric "${metric}": ${error.message}`);
				throw error;
			});
	}

	validateUrl(url) {
		try {
			const parsedUrl = new URL(url);
			if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
				throw new Error();
			}
			return null;
		} catch {
			return new Error('url must be a valid HTTP or HTTPS URL');
		}
	}

	createAuthConfig(config) {
		const hasUsername = typeof config.username === 'string' && config.username.length > 0;
		const hasPassword = typeof config.password === 'string' && config.password.length > 0;
		const hasBearerToken = typeof config.bearerToken === 'string' && config.bearerToken.length > 0;

		if (hasUsername !== hasPassword) {
			throw new Error('Both username and password are required for basic authentication');
		}
		if (hasBearerToken && (hasUsername || hasPassword)) {
			throw new Error('Configure either bearerToken or username/password, not both');
		}

		const authConfig = {};
		const headers = {};
		if (hasBearerToken) {
			headers.Authorization = `Bearer ${config.bearerToken}`;
		} else if (hasUsername) {
			authConfig.auth = { username: config.username, password: config.password };
		}

		if (typeof config.mimirTenantId === 'string' && config.mimirTenantId.length > 0) {
			headers['X-Scope-OrgID'] = config.mimirTenantId;
		}
		if (Object.keys(headers).length) {
			authConfig.headers = headers;
		}
		return authConfig;
	}
}
