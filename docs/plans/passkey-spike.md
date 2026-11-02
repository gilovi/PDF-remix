# Passkey PRF spike (Phase 6)

**Page:** https://pdf-remix.pages.dev/spikes/passkey/

It has to run on the real domain, because passkeys are tied to it. It needs no setup and no server. Press the highlighted button each time, and use **Test another provider** between combinations. Delete the page once Phase 7 is decided: remove `public/spikes/` and redeploy.

## Combinations to run

| Client | Provider to pick in the dialog |
|---|---|
| Chrome on Windows | Google Password Manager |
| Chrome on Windows | Windows Hello |
| Edge on Windows | Windows Hello |
| Chrome on Android | Google Password Manager |
| Chrome on Windows, using "phone" and the QR code | Google Password Manager on the phone |
| Second device, after sync | Choose "Already synced here" at step 2 |

## Result → what it decides

| Result | Decision |
|---|---|
| Usable bytes and `SAME BYTES`, whatever `prfEnabled` says | This provider can be offered as an unlock method |
| `NO USABLE PRF BYTES` | No unlock with this provider; show a clear message instead |
| `SAME BYTES` fails | The provider can't protect a key. Don't offer it |
| Second device hash equals the first device's | A synced passkey unlocks a vault there too, once the vault exists on that device |
| `provider` shows a name rather than `unknown` or `hidden` | Passkeys can be labelled automatically; otherwise the user names them |
| `backedUp` true | Losing the device doesn't lose this passkey |

## Results

### 2026-11-02: Chrome 156 on Windows, Windows Hello (AAGUID `9ddd1817-…`)

- `prf.enabled` is **false** at creation, on all three passkeys made.
- Unlock still returned 32 non-zero bytes, on both passkeys tried.
- Not backed up (`backupEligible` false), so this passkey is tied to the device.
- **Inconclusive:** each passkey was read only once, so stability is unknown. An early version of the page treated `enabled: false` as a failure and blocked the "unlock again" step. Fixed; needs another run.

**Still to run:** Windows Hello again for stability, Google Password Manager (not reached yet), Edge, Android, QR code, second device.
