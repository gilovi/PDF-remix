# Passkey PRF spike (Phase 6)

It ran on the real domain, because passkeys are tied to it, and needed no server. It has been removed; see Results.

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
| `backedUp` true | Losing the device doesn't lose this passkey |

## Results

### 2026-11-02: Chrome 156 on Windows, Windows Hello (AAGUID `9ddd1817-…`)

- `prf.enabled` is **false** at creation, on all three passkeys made.
- Unlock still returned 32 non-zero bytes, on both passkeys tried.
- Not backed up (`backupEligible` false), so this passkey is tied to the device.
- Three reads of one passkey gave the **same bytes**, including a discoverable read with no credential id given.
- Asking it to forget a passkey (`signalUnknownCredential`) **didn't work**: a passkey from an earlier run was still offered, and returned bytes. Removal must be by hand in Windows Settings.

### 2026-11-02: Chrome 156 on Windows, Google Password Manager (AAGUID `ea9b8d66-…`)

- `prf.enabled` is true at creation, with no bytes until the first unlock.
- Two reads gave the **same bytes**.
- Backed up (`backedUp` true), so it survives losing the device, and a transport of `hybrid` as well as `internal`.

### Decisions

- Offer one generic "Add passkey", accepting any provider that returns usable bytes on unlock. Both tested providers qualify.
- Don't check `prf.enabled`.
- The app doesn't identify the provider. The spike could read it from the AAGUID, but the app has no need to know, at the user's request.
- Don't promise that removing a passkey deletes it from the provider.

**Not run:** Edge, Android, QR code and second device. They aren't needed for the decision, as the app checks for usable bytes when a passkey is added. Whether a synced passkey gives the same bytes on a second device stays unknown, but a vault lives on one device anyway.

The test page was removed once these decisions were made. It's in git history at commit `1171b3a`.
