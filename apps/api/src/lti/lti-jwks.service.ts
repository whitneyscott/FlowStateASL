import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';
import * as jose from 'jose';

export interface LtiJwksResult {
  keys: jose.JWK[];
}

@Injectable()
export class LtiJwksService {
  private publicJwk: jose.JWK | null = null;
  private generatedPrivateKey: string | null = null;

  constructor(private readonly config: ConfigService) {}

  private getPublicKey(): crypto.KeyObject {
    const pem = this.config.get<string>('LTI_PRIVATE_KEY');
    if (pem?.trim()) {
      const priv = crypto.createPrivateKey(pem);
      return crypto.createPublicKey(priv);
    }
    if (!this.generatedPrivateKey) {
      const { privateKey } = crypto.generateKeyPairSync('rsa', {
        modulusLength: 2048,
        publicKeyEncoding: { type: 'spki', format: 'pem' },
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      });
      this.generatedPrivateKey = privateKey;
      if (process.env.NODE_ENV !== 'production') {
        console.log('[LTI] Generated RSA key pair (dev). Set LTI_PRIVATE_KEY in production.');
      }
    }
    return crypto.createPublicKey(this.generatedPrivateKey!);
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
