import { Injectable, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { createHash, randomBytes } from 'crypto';
import type { LtiContext } from '../common/interfaces/lti-context.interface';
import { sanitizeLtiContext } from '../common/utils/lti-context-value.util';
import { AuthSessionEntity } from './entities/auth-session.entity';

const AUTH_TTL_MS = 24 * 60 * 60 * 1000;
const NONCE_TTL_MS = 10 * 60 * 1000;

@Injectable()
export class AuthSessionService implements OnModuleInit {
  constructor(
    @InjectRepository(AuthSessionEntity)
    private readonly repo: Repository<AuthSessionEntity>,
    private readonly dataSource: DataSource,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.dataSource.query(`
      CREATE TABLE IF NOT EXISTS auth_sessions (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        token_hash varchar(128) NOT NULL UNIQUE,
        nonce_hash varchar(128) UNIQUE,
        nonce_expires_at timestamptz,
        expires_at timestamptz NOT NULL,
        course_id varchar(128) NOT NULL,
        canvas_user_id varchar(128) NOT NULL,
        resource_link_id varchar(255) NOT NULL DEFAULT '',
        canonical_key varchar(512) NOT NULL,
        lti_launch_type varchar(8) NOT NULL DEFAULT '1.1',
        canvas_access_token text,
        lti_context jsonb NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );
    `);
    await this.dataSource.query(
      `CREATE INDEX IF NOT EXISTS idx_auth_sessions_expires_at ON auth_sessions (expires_at);`,
    );
    await this.dataSource.query(
      `CREATE INDEX IF NOT EXISTS idx_auth_sessions_canonical_key ON auth_sessions (canonical_key);`,
    );
    await this.dataSource.query(`
      DELETE FROM auth_sessions
      WHERE expires_at < now()
         OR (nonce_expires_at IS NOT NULL AND nonce_expires_at < now() - interval '1 day');
    `);
  }

  private hash(value: string): string {
    return createHash('sha256').update(value, 'utf8').digest('hex');
  }

  private mintOpaqueToken(): string {
    return randomBytes(32).toString('hex');
  }

  private canonicalKeyFromContext(ctx: LtiContext): string {
    const canvasUserId = (ctx.canvasUserId ?? ctx.userId ?? '').trim();
    return `${canvasUserId}::${(ctx.courseId ?? '').trim()}::${(ctx.resourceLinkId ?? '').trim()}`;
  }

  async issueFromLaunch(
    ctx: LtiContext,
    launchType: '1.1' | '1.3',
    existingCanvasAccessToken?: string | null,
  ): Promise<{ bearerToken: string; bootstrapNonce: string }> {
    const bearerToken = this.mintOpaqueToken();
    const bootstrapNonce = this.mintOpaqueToken();
    const now = Date.now();
    const expiresAt = new Date(now + AUTH_TTL_MS);
    const nonceExpiresAt = new Date(now + NONCE_TTL_MS);
    const sanitized = sanitizeLtiContext(ctx);
    const ltiContextToStore = { ...sanitized, ltiLaunchType: launchType } as unknown as Record<string, unknown>;
    const canvasUserId = ((sanitized.canvasUserId ?? '').trim() || sanitized.userId || '').trim();
    const row = this.repo.create({
      tokenHash: this.hash(bearerToken),
      nonceHash: this.hash(bootstrapNonce),
      nonceExpiresAt,
      expiresAt,
      courseId: (sanitized.courseId ?? '').trim(),
      canvasUserId,
      resourceLinkId: (sanitized.resourceLinkId ?? '').trim(),
      canonicalKey: this.canonicalKeyFromContext(sanitized),
      ltiLaunchType: launchType,
      canvasAccessToken: existingCanvasAccessToken?.trim() || null,
      ltiContext: ltiContextToStore,
    });
    await this.repo.save(row);
    return { bearerToken, bootstrapNonce };
  }

  async getByBearerToken(
    bearerToken: string,
  ): Promise<{ row: AuthSessionEntity; ctx: LtiContext } | null> {
    const tokenHash = this.hash(bearerToken.trim());
    const row = await this.repo.findOne({ where: { tokenHash } });
    if (!row) return null;
    if (row.expiresAt.getTime() <= Date.now()) {
      await this.repo.delete({ id: row.id });
      return null;
    }
    const ctx = sanitizeLtiContext({
      ...(row.ltiContext ?? {}),
      ltiLaunchType: row.ltiLaunchType,
    } as unknown as LtiContext);
    return { row, ctx };
  }

  async consumeBootstrapNonce(
    nonce: string,
  ): Promise<{ bearerToken: string; rotatedNonce: string; row: AuthSessionEntity; ctx: LtiContext } | null> {
    const nonceHash = this.hash(nonce.trim());
    const row = await this.repo.findOne({ where: { nonceHash } });
    if (!row) return null;
    const now = Date.now();
    if (
      row.expiresAt.getTime() <= now ||
      !row.nonceExpiresAt ||
      row.nonceExpiresAt.getTime() <= now
    ) {
      await this.repo.delete({ id: row.id });
      return null;
    }
    const bearerToken = this.mintOpaqueToken();
    const rotatedNonce = this.mintOpaqueToken();
    row.tokenHash = this.hash(bearerToken);
    row.nonceHash = this.hash(rotatedNonce);
    row.nonceExpiresAt = new Date(now + NONCE_TTL_MS);
    await this.repo.save(row);
    const ctx = sanitizeLtiContext({
      ...(row.ltiContext ?? {}),
      ltiLaunchType: row.ltiLaunchType,
    } as unknown as LtiContext);
    return { bearerToken, rotatedNonce, row, ctx };
  }

  async rotateNonceForSession(rowId: string): Promise<string> {
    const row = await this.repo.findOne({ where: { id: rowId } });
    if (!row) return '';
    const rotatedNonce = this.mintOpaqueToken();
    row.nonceHash = this.hash(rotatedNonce);
    row.nonceExpiresAt = new Date(Date.now() + NONCE_TTL_MS);
    await this.repo.save(row);
    return rotatedNonce;
  }

  async getBySessionId(rowId: string): Promise<{ row: AuthSessionEntity; ctx: LtiContext } | null> {
    const row = await this.repo.findOne({ where: { id: rowId } });
    if (!row) return null;
    if (row.expiresAt.getTime() <= Date.now()) {
      await this.repo.delete({ id: row.id });
      return null;
    }
    const ctx = sanitizeLtiContext({
      ...(row.ltiContext ?? {}),
      ltiLaunchType: row.ltiLaunchType,
    } as unknown as LtiContext);
    return { row, ctx };
  }

  async updateSessionState(
    rowId: string,
    patch: Partial<Pick<AuthSessionEntity, 'canvasAccessToken' | 'ltiLaunchType' | 'ltiContext'>>,
  ): Promise<void> {
    const row = await this.repo.findOne({ where: { id: rowId } });
    if (!row) return;
    if (patch.canvasAccessToken !== undefined) {
      row.canvasAccessToken = patch.canvasAccessToken?.trim() || null;
    }
    if (patch.ltiLaunchType) {
      row.ltiLaunchType = patch.ltiLaunchType;
    }
    if (patch.ltiContext) {
      row.ltiContext = patch.ltiContext;
      const ctx = sanitizeLtiContext(patch.ltiContext as unknown as LtiContext);
      row.courseId = (ctx.courseId ?? '').trim();
      row.canvasUserId = ((ctx.canvasUserId ?? '').trim() || ctx.userId || '').trim();
      row.resourceLinkId = (ctx.resourceLinkId ?? '').trim();
      row.canonicalKey = this.canonicalKeyFromContext(ctx);
    }
    await this.repo.save(row);
  }
}
