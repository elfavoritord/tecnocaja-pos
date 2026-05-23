'use strict';

class StatusService {
  constructor({ authService, dgiiClient, logger, storageService, config }) {
    this.authService = authService;
    this.dgiiClient = dgiiClient;
    this.logger = logger;
    this.storageService = storageService || null;
    this.config = config || dgiiClient?.config || null;
  }

  async getTrackStatus(trackId) {
    const auth = await this.authService.authenticate();
    const response = await this.dgiiClient.getTrackStatus({
      token: auth.token,
      trackId,
    });
    this.logger.info('Consulta TrackId ejecutada.', {
      trackId,
      status: response.http?.status,
      elapsedMs: response.http?.elapsedMs,
    });
    this.storageService?.saveTrackStatus({
      trackId,
      payload: response,
      environment: this.config?.DGII_ENV,
      httpStatus: response.http?.status,
    });
    return response;
  }

  async getEcfStatus(params) {
    const auth = await this.authService.authenticate();
    const response = await this.dgiiClient.getEcfStatus({
      token: auth.token,
      ...params,
    });
    this.logger.info('Consulta estado e-CF ejecutada.', {
      status: response.http?.status,
      elapsedMs: response.http?.elapsedMs,
      ncfelectronico: params?.ncfelectronico,
    });
    return response;
  }
}

module.exports = {
  StatusService,
};
