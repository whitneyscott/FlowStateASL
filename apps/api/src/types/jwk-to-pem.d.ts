declare module 'jwk-to-pem' {
  function jwkToPem(jwk: { kty: string; n?: string; e?: string; [key: string]: unknown }): string;
  export = jwkToPem;
}
