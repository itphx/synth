import { describe, expect, it } from 'vitest';

import { isSecretDirectoryName, isSecretFileName } from './secret-files.js';

describe('политика файлов/каталогов секретов', () => {
  it('точные имена и варианты .env', () => {
    expect(isSecretFileName('.env')).toBe(true);
    expect(isSecretFileName('.ENV')).toBe(true);
    expect(isSecretFileName('.env.production')).toBe(true);
    expect(isSecretFileName('.env.example')).toBe(true);
    expect(isSecretFileName('.npmrc')).toBe(true);
    expect(isSecretFileName('.netrc')).toBe(true);
    expect(isSecretFileName('credentials')).toBe(true);
    expect(isSecretFileName('credentials.json')).toBe(true);
    expect(isSecretFileName('secrets.yaml')).toBe(true);
    expect(isSecretFileName('secret.yml')).toBe(true);
    expect(isSecretFileName('service-account-prod.json')).toBe(true);
  });

  it('ключи, сертификаты и состояния', () => {
    expect(isSecretFileName('id_rsa')).toBe(true);
    expect(isSecretFileName('id_ed25519.pub')).toBe(true);
    expect(isSecretFileName('server.pem')).toBe(true);
    expect(isSecretFileName('server.key')).toBe(true);
    expect(isSecretFileName('store.p12')).toBe(true);
    expect(isSecretFileName('store.pfx')).toBe(true);
    expect(isSecretFileName('vault.kdbx')).toBe(true);
    expect(isSecretFileName('terraform.tfstate')).toBe(true);
    expect(isSecretFileName('terraform.tfstate.backup')).toBe(true);
  });

  it('обычные файлы не считаются секретными', () => {
    expect(isSecretFileName('README.md')).toBe(false);
    expect(isSecretFileName('config.yaml')).toBe(false);
    expect(isSecretFileName('credentials-guide.md')).toBe(false);
    expect(isSecretFileName('secret-guide.md')).toBe(false);
    expect(isSecretFileName('environment.ts')).toBe(false);
    expect(isSecretFileName('main.ts')).toBe(false);
  });

  it('каталоги секретов', () => {
    for (const name of ['.ssh', '.gnupg', '.aws', '.kube', '.docker', '.terraform', '.gcloud', 'secrets']) {
      expect(isSecretDirectoryName(name)).toBe(true);
      expect(isSecretDirectoryName(name.toUpperCase())).toBe(true);
    }
    expect(isSecretDirectoryName('src')).toBe(false);
    expect(isSecretDirectoryName('docs')).toBe(false);
    expect(isSecretDirectoryName('secret')).toBe(false);
  });
});
