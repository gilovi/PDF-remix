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
| `prfEnabled` true, usable bytes, `SAME BYTES` | This provider can be offered as an unlock method |
| `prfEnabled` false, or `NO USABLE PRF BYTES` | No unlock with this provider; show a clear message instead |
| `SAME BYTES` fails | The provider can't protect a key. Don't offer it |
| Second device hash equals the first device's | A synced passkey unlocks a vault there too, once the vault exists on that device |
| `provider` shows a name rather than `unknown` or `hidden` | Passkeys can be labelled automatically; otherwise the user names them |
| `backedUp` true | Losing the device doesn't lose this passkey |

## Results

Not run yet.
