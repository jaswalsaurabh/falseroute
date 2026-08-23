import {
  PubSubPushEnvelopeSchema,
  IntrusionEventEnvelopeSchema,
  UuidSchema,
  validateScenarioEvidence,
} from '@false-route/contracts';
import { type AutonomousWorkflowRepository } from '@false-route/database';
import { type AutonomousWorkflowOrchestrator } from '../orchestration/autonomous-workflow.js';
import { createHash, timingSafeEqual } from 'node:crypto';
import { OAuth2Client } from 'google-auth-library';

export interface OidcTokenVerifier {
  verifyToken(
    authHeader: string | undefined,
    context: { readonly expectedAudience?: string; readonly expectedServiceAccount?: string },
  ): Promise<{ valid: boolean; email?: string; audience?: string }>;
}

interface IdTokenClient {
  verifyIdToken(options: {
    readonly idToken: string;
    readonly audience?: string;
  }): Promise<{ getPayload(): { email?: string; aud: string } | undefined }>;
}

/** Verifies Google-signed service-account ID tokens and returns bounded identity claims. */
export class GoogleOidcTokenVerifier implements OidcTokenVerifier {
  constructor(private readonly client: IdTokenClient = new OAuth2Client()) {}

  async verifyToken(
    authHeader: string | undefined,
    context: { readonly expectedAudience?: string },
  ): Promise<{ valid: boolean; email?: string; audience?: string }> {
    const match = authHeader?.match(/^Bearer ([^\s]+)$/);
    if (!match) return { valid: false };

    try {
      const ticket = await this.client.verifyIdToken({
        idToken: match[1]!,
        ...(context.expectedAudience ? { audience: context.expectedAudience } : {}),
      });
      const payload = ticket.getPayload();
      if (!payload) return { valid: false };
      return {
        valid: true,
        ...(payload.email ? { email: payload.email } : {}),
        audience: payload.aud,
      };
    } catch {
      return { valid: false };
    }
  }
}

/** Exact shared-secret verifier for loopback-only local development transport. */
export class LocalSharedSecretOidcTokenVerifier implements OidcTokenVerifier {
  constructor(private readonly expectedSecret: string) {
    if (expectedSecret.length < 16) {
      throw new Error('Local push shared secret must be at least 16 characters');
    }
  }

  async verifyToken(authHeader?: string): Promise<{ valid: boolean; email?: string }> {
    if (!authHeader?.startsWith('Bearer ')) {
      return { valid: false };
    }
    const supplied = Buffer.from(authHeader.slice(7).trim());
    const expected = Buffer.from(this.expectedSecret);
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      return { valid: false };
    }
    return { valid: true, email: 'local-falseroute-worker@example.invalid' };
  }
}

export interface PushHandlerResponse {
  readonly statusCode: number;
  readonly body: Record<string, unknown>;
}

export class PubSubPushHandler {
  constructor(
    private readonly orchestrator: AutonomousWorkflowOrchestrator,
    private readonly tokenVerifier: OidcTokenVerifier,
    private readonly workflowRepo: AutonomousWorkflowRepository,
    private readonly identity: {
      readonly expectedAudience?: string;
      readonly expectedServiceAccount?: string;
    } = {},
  ) {}

  async handlePushRequest(
    authHeader: string | undefined,
    rawBody: unknown,
  ): Promise<PushHandlerResponse> {
    // 1. Verify OIDC identity (fail closed)
    if (!(await this.isAuthorized(authHeader))) {
      return {
        statusCode: 401,
        body: { error: 'UNAUTHORIZED', message: 'Invalid or missing OIDC push bearer token' },
      };
    }

    // 2. Parse Pub/Sub envelope
    const envelopeParsed = PubSubPushEnvelopeSchema.safeParse(rawBody);
    if (!envelopeParsed.success) {
      const serialized = (() => {
        try {
          return JSON.stringify(rawBody);
        } catch {
          return String(rawBody);
        }
      })();
      const syntheticMsgId = `poison-env-${createHash('sha256').update(serialized).digest('hex').slice(0, 32)}`;
      const quarantineFailure = await this.tryQuarantinePoisonMessage(
        syntheticMsgId,
        undefined,
        'Poison Pub/Sub envelope schema rejected',
        rawBody,
      );
      if (quarantineFailure) return quarantineFailure;

      return {
        statusCode: 200,
        body: {
          status: 'QUARANTINED',
          message: 'Poison Pub/Sub envelope schema rejected and quarantined',
        },
      };
    }

    const { message } = envelopeParsed.data;

    // 3. Decode base64 message data
    let decodedJson: unknown;
    try {
      const decodedString = Buffer.from(message.data, 'base64').toString('utf8');
      decodedJson = JSON.parse(decodedString);
    } catch {
      const quarantineFailure = await this.tryQuarantinePoisonMessage(
        message.messageId,
        undefined,
        'Unparseable base64 JSON payload',
        { rawData: message.data },
      );
      if (quarantineFailure) return quarantineFailure;

      return {
        statusCode: 200,
        body: { status: 'QUARANTINED', message: 'Unparseable payload quarantined' },
      };
    }

    // 4. Validate IntrusionEventEnvelope
    const intrusionParsed = IntrusionEventEnvelopeSchema.safeParse(decodedJson);
    const evidenceValidation = intrusionParsed.success
      ? validateScenarioEvidence(intrusionParsed.data.scenarioKind, intrusionParsed.data.evidence)
      : undefined;
    const evidenceError =
      evidenceValidation !== undefined && !evidenceValidation.success
        ? evidenceValidation.error
        : undefined;
    if (!intrusionParsed.success || evidenceError !== undefined) {
      const eventIdCandidate =
        decodedJson && typeof decodedJson === 'object' && 'eventId' in decodedJson
          ? String((decodedJson as Record<string, unknown>).eventId)
          : undefined;
      const originalEventId = UuidSchema.safeParse(eventIdCandidate).success
        ? eventIdCandidate
        : undefined;

      const quarantineFailure = await this.tryQuarantinePoisonMessage(
        message.messageId,
        originalEventId,
        'Schema-invalid intrusion event envelope',
        decodedJson,
      );
      if (quarantineFailure) return quarantineFailure;

      return {
        statusCode: 200,
        body: {
          status: 'QUARANTINED',
          message: 'Schema-invalid intrusion event quarantined',
          errors: intrusionParsed.success
            ? [evidenceError ?? 'Invalid scenario evidence']
            : intrusionParsed.error.issues,
        },
      };
    }

    // 5. Process through autonomous workflow orchestrator
    try {
      const result = await this.orchestrator.processEventEnvelope(
        {
          ...intrusionParsed.data,
          evidence:
            evidenceValidation && evidenceValidation.success
              ? evidenceValidation.data
              : intrusionParsed.data.evidence,
        },
        message.messageId,
      );

      return {
        statusCode: 200,
        body: {
          status: result.status,
          eventId: result.eventId,
          executedActions: result.executedActions,
        },
      };
    } catch (err) {
      // Transient error: return 500 to request Pub/Sub backoff redelivery
      return {
        statusCode: 500,
        body: {
          error: 'TRANSIENT_FAILURE',
          message: err instanceof Error ? err.message : String(err),
        },
      };
    }
  }

  /** Persists messages exhausted by Pub/Sub so the operator replay API can inspect them. */
  async handleDeadLetterRequest(
    authHeader: string | undefined,
    rawBody: unknown,
  ): Promise<PushHandlerResponse> {
    if (!(await this.isAuthorized(authHeader))) {
      return {
        statusCode: 401,
        body: { error: 'UNAUTHORIZED', message: 'Invalid or missing OIDC push bearer token' },
      };
    }

    const envelopeParsed = PubSubPushEnvelopeSchema.safeParse(rawBody);
    if (!envelopeParsed.success) {
      return {
        statusCode: 503,
        body: {
          error: 'DEAD_LETTER_INTAKE_REJECTED',
          message: 'Dead-letter envelope was not durably recorded; delivery must be retried',
        },
      };
    }

    const { message } = envelopeParsed.data;
    let decodedJson: unknown;
    try {
      decodedJson = JSON.parse(Buffer.from(message.data, 'base64').toString('utf8'));
    } catch {
      return this.persistBrokerDeadLetter(
        message,
        undefined,
        'Pub/Sub delivery attempts exhausted; payload is not valid JSON',
        { rawData: message.data },
      );
    }

    const intrusionParsed = IntrusionEventEnvelopeSchema.safeParse(decodedJson);
    const evidenceValidation = intrusionParsed.success
      ? validateScenarioEvidence(intrusionParsed.data.scenarioKind, intrusionParsed.data.evidence)
      : undefined;
    if (!intrusionParsed.success || !evidenceValidation?.success) {
      const eventIdCandidate =
        decodedJson && typeof decodedJson === 'object' && 'eventId' in decodedJson
          ? String((decodedJson as Record<string, unknown>).eventId)
          : undefined;
      return this.persistBrokerDeadLetter(
        message,
        UuidSchema.safeParse(eventIdCandidate).success ? eventIdCandidate : undefined,
        'Pub/Sub delivery attempts exhausted; event schema is invalid',
        decodedJson,
      );
    }

    return this.persistBrokerDeadLetter(
      message,
      intrusionParsed.data.eventId,
      'Pub/Sub delivery attempts exhausted',
      intrusionParsed.data,
    );
  }

  private async persistBrokerDeadLetter(
    message: {
      readonly messageId: string;
      readonly attributes?: Readonly<Record<string, string>> | undefined;
    },
    eventId: string | undefined,
    reason: string,
    payload: unknown,
  ): Promise<PushHandlerResponse> {
    const deliveryCount = Number(
      message.attributes?.['CloudPubSubDeadLetterSourceDeliveryCount'] ?? 0,
    );
    const safePayload =
      payload && typeof payload === 'object'
        ? (payload as Record<string, unknown>)
        : { raw: String(payload) };
    try {
      await this.workflowRepo.recordDeadLetter({
        originalMessageId: message.messageId,
        ...(eventId ? { originalEventId: eventId } : {}),
        failureReason: reason,
        payload: safePayload,
        retryCount: Number.isSafeInteger(deliveryCount) && deliveryCount >= 0 ? deliveryCount : 0,
      });
      return {
        statusCode: 200,
        body: { status: 'QUARANTINED', message: 'Dead-letter event durably recorded' },
      };
    } catch {
      return {
        statusCode: 503,
        body: {
          error: 'QUARANTINE_UNAVAILABLE',
          message: 'Dead-letter event was not durably recorded; delivery must be retried',
        },
      };
    }
  }

  private async isAuthorized(authHeader: string | undefined): Promise<boolean> {
    const authResult = await this.tokenVerifier.verifyToken(authHeader, this.identity);
    const identityMismatch =
      (this.identity.expectedServiceAccount !== undefined &&
        authResult.email !== this.identity.expectedServiceAccount) ||
      (this.identity.expectedAudience !== undefined &&
        authResult.audience !== this.identity.expectedAudience);
    return authResult.valid && !identityMismatch;
  }

  private async tryQuarantinePoisonMessage(
    messageId: string,
    eventId: string | undefined,
    reason: string,
    payload: unknown,
  ): Promise<PushHandlerResponse | undefined> {
    try {
      const safePayload =
        payload && typeof payload === 'object'
          ? (payload as Record<string, unknown>)
          : { raw: String(payload) };

      await this.workflowRepo.recordDeadLetter({
        originalMessageId: messageId,
        ...(eventId ? { originalEventId: eventId } : {}),
        failureReason: reason,
        payload: safePayload,
      });
      return undefined;
    } catch {
      return {
        statusCode: 503,
        body: {
          error: 'QUARANTINE_UNAVAILABLE',
          message: 'Poison payload was not durably quarantined; delivery must be retried',
        },
      };
    }
  }
}
