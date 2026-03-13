import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';
import * as jose from 'jose';
import { getLtiPrivateKeyPem } from './lti-key.util';

export interface LtiJwksResult {
  keys: jose.JWK[];
}

@Injectable()
export class LtiJwksService {
  private publicJwk: jose.JWK | null = null;

  constructor(private readonly config: ConfigService) {}

  private getPublicKey(): crypto.KeyObject {
    const pem = getLtiPrivateKeyPem(this.config);
    const priv = crypto.createPrivateKey(pem);
    return crypto.createPublicKey(priv);
  }

  async getPublicJwk(): Promise<jose.JWK> {
    if (this.publicJwk) return this.publicJwk;
    const publicKey = this.getPublicKey();
    const jwk = await jose.exportJWK(publicKey);
    jwk.alg = 'RS256';
    jwk.use = 'sig';
    jwk.kid = jwk.kid ?? 'default';
    this.publicJwk = jwk;
    return jwk;
  }

  async getJwks(): Promise<LtiJwksResult> {
    const jwk = await this.getPublicJwk();
    return { keys: [jwk] };
  }
}
