const axios = require('axios');

const PLUGIN_NAME = 'homebridge-prometheus-sensor2';
const PLATFORM_NAME = 'PrometheusSensorPlugin2';

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
		} catch (error) {
			this.configurationError = error;
			this.authConfig = {};
		}
		this.uuid = api.hap.uuid.generate(PLUGIN_NAME);
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

		const accessory = this.cachedAccessories.find((cached) => cached.UUID === this.uuid)
			|| new this.api.platformAccessory(this.name, this.uuid);
		const staleAccessories = this.cachedAccessories.filter((cached) => cached.UUID !== this.uuid);
		const Service = this.api.hap.Service;
		const Characteristic = this.api.hap.Characteristic;
		accessory.displayName = this.name;

		this.addService(accessory, Service.CarbonDioxideSensor, 'Co2 Sensor')
			.getCharacteristic(Characteristic.CarbonDioxideLevel)
			.onGet(this.handleCo2Get.bind(this));

		this.addService(accessory, Service.LightSensor, 'Solar Power Watts')
			.getCharacteristic(Characteristic.CurrentAmbientLightLevel)
			.onGet(this.handlePowerGet.bind(this));

		this.addService(accessory, Service.HumiditySensor, 'Humidity')
			.getCharacteristic(Characteristic.CurrentRelativeHumidity)
			.onGet(this.handleHumidityGet.bind(this));

		const information = accessory.getService(Service.AccessoryInformation)
			|| accessory.addService(Service.AccessoryInformation);
		information
			.setCharacteristic(Characteristic.Manufacturer, 'Prometheus')
			.setCharacteristic(Characteristic.Model, 'Prometheus Sensor');

		if (staleAccessories.length) {
			this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, staleAccessories);
		}
		if (!this.cachedAccessories.includes(accessory)) {
			this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
		}
	}

	addService(accessory, serviceType, name) {
		return accessory.getService(serviceType) || accessory.addService(serviceType, name);
	}

	handleCo2Get() {
		this.log.debug('Triggered GET CarbonDioxideLevel');
		return this.queryPrometheus('rco2');
	}

	handlePowerGet() {
		this.log.debug('Triggered GET CurrentAmbientLightLevel');
		return this.queryPrometheus('input_power').then((value) => Math.max(value, 0.0001));
	}

	handleHumidityGet() {
		this.log.debug('Triggered GET CurrentRelativeHumidity');
		return this.queryPrometheus('humidity').then((value) => {
			if (value < 0 || value > 100) {
				const error = new Error(`Prometheus humidity value must be between 0 and 100; received ${value}`);
				this.log.error(`Failed to read humidity metric: ${error.message}`);
				throw error;
			}
			return value;
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
