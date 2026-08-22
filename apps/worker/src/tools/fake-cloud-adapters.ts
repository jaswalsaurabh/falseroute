export interface DecoyDeploymentResult {
  readonly serviceId: string;
  readonly serviceUrl: string;
  readonly status: 'SIMULATED';
  readonly healthStatus: 'HEALTHY';
  readonly deployedAt: string;
}

export interface FalseRouteResult {
  readonly routeId: string;
  readonly sourceIp: string;
  readonly assignedTarget: string;
  readonly status: 'SIMULATED';
  readonly assignedAt: string;
}

export interface CloudArmorQuarantineResult {
  readonly ruleId: string;
  readonly policyName: string;
  readonly sourceCidr: string;
  readonly rulePriority: number;
  readonly status: 'SIMULATED';
  readonly enforcedAt: string;
}

export class FakeCloudRunAdapter {
  async deployDecoy(params: {
    templateName: string;
    region: string;
    ttlSeconds: number;
  }): Promise<DecoyDeploymentResult> {
    const serviceId = `cr-${params.templateName}-${Date.now().toString(36)}`;
    const serviceUrl = `https://${serviceId}-${params.region}.run.app.dummy`;

    return {
      serviceId,
      serviceUrl,
      status: 'SIMULATED',
      healthStatus: 'HEALTHY',
      deployedAt: new Date().toISOString(),
    };
  }

  async deleteDecoy(_serviceId: string): Promise<{ deleted: boolean; status: 'SIMULATED' }> {
    return { deleted: true, status: 'SIMULATED' };
  }
}

export class FakeFalseRouteAdapter {
  private activeRoutes = new Map<string, string>();

  async assignRoute(params: {
    sourceIp: string;
    targetService: string;
  }): Promise<FalseRouteResult> {
    const routeId = `fr-route-${Date.now().toString(36)}`;
    this.activeRoutes.set(params.sourceIp, params.targetService);

    return {
      routeId,
      sourceIp: params.sourceIp,
      assignedTarget: params.targetService,
      status: 'SIMULATED',
      assignedAt: new Date().toISOString(),
    };
  }

  async revokeRoute(sourceIp: string): Promise<{ revoked: boolean; status: 'SIMULATED' }> {
    this.activeRoutes.delete(sourceIp);
    return { revoked: true, status: 'SIMULATED' };
  }
}

export class FakeCloudArmorAdapter {
  private allocatedPriority = 1050;

  async applyQuarantine(params: {
    sourceCidr: string;
    policyName?: string;
  }): Promise<CloudArmorQuarantineResult> {
    const rulePriority = this.allocatedPriority;
    this.allocatedPriority += 1;

    return {
      ruleId: `ca-rule-${Date.now().toString(36)}`,
      policyName: params.policyName ?? 'falseroute-quarantine-policy',
      sourceCidr: params.sourceCidr,
      rulePriority,
      status: 'SIMULATED',
      enforcedAt: new Date().toISOString(),
    };
  }

  async releaseQuarantine(
    _sourceCidr: string,
  ): Promise<{ released: boolean; status: 'SIMULATED' }> {
    return { released: true, status: 'SIMULATED' };
  }
}
