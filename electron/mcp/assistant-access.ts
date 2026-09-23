import { app, ipcMain } from 'electron';
import { warn } from 'electron-log/main';
import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import { join } from 'path';
import { IPC } from '../shared-with-frontend/ipc-events.const';
import { SimpleStoreKey } from '../shared-with-frontend/simple-store.const';
import {
  ASSISTANT_ACCESS_SCOPES,
  AssistantAccessCredentialResult,
  AssistantAccessScope,
  AssistantAccessState,
} from '../shared-with-frontend/assistant-access.model';
import { loadSimpleStoreAll, saveSimpleStore } from '../simple-store';
import { readSecretFile, writeSecretFile } from '../secure-file';

/**
 * Device-local settings and credential for assistant (MCP) access.
 *
 * The switch and the granted scopes live in main's simple store; the credential
 * is never stored — only a SHA-256 verifier in a 0600 file — so it can be shown
 * once, when generated, and a copied profile cannot leak it. Nothing here is in
 * the synced config: a synced grant would authorise an assistant on devices the
 * user never set up.
 */

const VERIFIER_LABEL = 'assistant access verifier';
const VERIFIER_PATTERN = /^[a-f0-9]{64}$/;
const CREDENTIAL_PREFIX = 'sp_mcp_';

interface PersistedSettings {
  isEnabled: boolean;
  scopes: AssistantAccessScope[];
}

let isEnabled = false;
let scopes: AssistantAccessScope[] = [];
let verifier: Buffer | undefined = undefined;
let isInitialized = false;
// Resolves once the persisted settings are in memory; every change waits for it
// so a write at startup cannot replace stored scopes with the defaults.
let loaded: Promise<void> = Promise.resolve();
let onListenerNeedChanged: () => Promise<void> = async () => undefined;
let getListenerStatus: () => Pick<
  AssistantAccessState,
  'isListening' | 'error'
> = () => ({
  isListening: false,
});

const getVerifierFilePath = (): string =>
  join(app.getPath('userData'), 'assistant-access-verifier');

const hashCredential = (credential: string): Buffer =>
  createHash('sha256').update(credential, 'utf8').digest();

/**
 * Keeps only known scopes, in canonical order, and drops notes access when
 * summary access is missing — notes are only reachable through a task read.
 */
export const normalizeScopes = (input: unknown): AssistantAccessScope[] => {
  if (!Array.isArray(input)) {
    return [];
  }
  const requested = ASSISTANT_ACCESS_SCOPES.filter((scope) => input.includes(scope));
  return requested.includes('tasks:read')
    ? requested
    : requested.filter((scope) => scope !== 'tasks:read_notes');
};

const toPersisted = (): PersistedSettings => ({ isEnabled, scopes: [...scopes] });

const persist = async (next: PersistedSettings): Promise<void> => {
  await saveSimpleStore(SimpleStoreKey.ASSISTANT_ACCESS, next);
};

export const isAssistantAccessEnabled = (): boolean => isEnabled;

export const getAssistantAccessScopes = (): readonly AssistantAccessScope[] =>
  isEnabled ? scopes : [];

/** Constant-time check of a presented credential against the stored verifier. */
export const verifyAssistantCredential = (candidate: string): boolean => {
  if (!isEnabled || !verifier) {
    return false;
  }
  return timingSafeEqual(hashCredential(candidate), verifier);
};

export const getAssistantAccessState = (): AssistantAccessState => ({
  isEnabled,
  scopes: [...scopes],
  hasCredential: !!verifier,
  ...getListenerStatus(),
});

const setEnabled = async (next: boolean): Promise<AssistantAccessState> => {
  await loaded;
  // Persist first: the switch must not report "off" and come back on at the
  // next launch.
  await persist({ ...toPersisted(), isEnabled: next });
  isEnabled = next;
  await onListenerNeedChanged();
  return getAssistantAccessState();
};

const setScopes = async (input: unknown): Promise<AssistantAccessState> => {
  await loaded;
  const next = normalizeScopes(input);
  await persist({ ...toPersisted(), scopes: next });
  // Every request reads the scopes at dispatch time, so a narrowed grant
  // applies to requests already in flight too.
  scopes = next;
  return getAssistantAccessState();
};

const rotateCredential = async (): Promise<AssistantAccessCredentialResult> => {
  const credential = CREDENTIAL_PREFIX + randomBytes(32).toString('base64url');
  const nextVerifier = hashCredential(credential);
  // Durable before live, so a failed write can never bring the old credential
  // back on the next launch.
  writeSecretFile(getVerifierFilePath(), nextVerifier.toString('hex'), VERIFIER_LABEL);
  verifier = nextVerifier;
  return { credential, state: getAssistantAccessState() };
};

const loadPersisted = async (): Promise<void> => {
  let stored: unknown;
  try {
    stored = (await loadSimpleStoreAll())[SimpleStoreKey.ASSISTANT_ACCESS];
  } catch (error) {
    warn('[assistant-access] Could not read settings — staying off', error);
    return;
  }
  if (typeof stored !== 'object' || stored === null) {
    return;
  }
  const record = stored as Record<string, unknown>;
  scopes = normalizeScopes(record.scopes);
  isEnabled = record.isEnabled === true;
  void onListenerNeedChanged();
};

export interface AssistantAccessHooks {
  /**
   * Called whenever the listener may need to start or stop; resolves once a
   * resulting listen() has bound or failed.
   */
  onListenerNeedChanged: () => Promise<void>;
  getListenerStatus: () => Pick<AssistantAccessState, 'isListening' | 'error'>;
}

export const initAssistantAccess = (hooks: AssistantAccessHooks): void => {
  if (isInitialized) {
    return;
  }
  isInitialized = true;
  onListenerNeedChanged = hooks.onListenerNeedChanged;
  getListenerStatus = hooks.getListenerStatus;

  const stored = readSecretFile(getVerifierFilePath(), VERIFIER_PATTERN, VERIFIER_LABEL);
  verifier = stored ? Buffer.from(stored, 'hex') : undefined;

  loaded = loadPersisted();

  ipcMain.handle(IPC.ASSISTANT_ACCESS_GET_STATE, async () => {
    await loaded;
    return getAssistantAccessState();
  });
  ipcMain.handle(IPC.ASSISTANT_ACCESS_SET_ENABLED, (_ev, next: unknown) => {
    if (typeof next !== 'boolean') {
      throw new Error('Invalid enabled value');
    }
    return setEnabled(next);
  });
  ipcMain.handle(IPC.ASSISTANT_ACCESS_SET_SCOPES, (_ev, next: unknown) =>
    setScopes(next),
  );
  ipcMain.handle(IPC.ASSISTANT_ACCESS_ROTATE_CREDENTIAL, () => rotateCredential());
};
