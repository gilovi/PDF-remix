# Restore unsaved work: plan

Backlog item "Local file history" (`docs/plans/backlog.md` on branch `claude/elated-elion-77fd87`): reopen work that hasn't been downloaded, after closing the tab or reloading.

## Decisions
- **From the user:** encrypted, and only for work not yet downloaded.
- **On by default?** The backlog left this open. It follows the same rule as signatures: on while the vault is open, and nothing is kept otherwise. Nothing asks for the vault just because a file was opened. A small note in the bottom bar says whether work is being kept, with a button to turn it on.
- **What counts as work:** a change to the page list or its items. Opening a file and changing nothing keeps nothing.
- **Undo history isn't kept.**

## Design
- **Encryption:** the vault's data key, through new `sealBytes` and `openBytes` in `src/vault.ts`. Each record's additional data names its draft and file, so records can't be swapped.
- **Storage:** two new IndexedDB stores beside the vault. A draft record holds the page list, names and signatures. Source files are separate records, written once, so an edit doesn't rewrite a large PDF.
- **Not encrypted:** only each draft's id, time and size, so the page can say unsaved work exists before unlocking. File names are encrypted.
- **Saving:** a short delay after each change, while the vault is open.
- **Limits:** 5 drafts and 500 MB in total, dropping the oldest. A single document over 200 MB isn't kept, and the note says so.
- **Removed when:** the document is downloaded, or discarded with Start over. Deleting the vault also deletes all drafts.
- **Changing the passphrase** changes the key, so drafts are re-encrypted. A failure part way leaves some drafts unreadable. They're listed as such and can be deleted.
- **Restoring:** a banner on the start screen, offered when drafts exist, unlocks the vault and lists them. Each can be restored or deleted, and all can be cleared. Restored items get fresh ids, so they can't clash with new ones.

## Limits to be honest about
Browsers can clear this data, so it's a convenience and not a backup. The fine print says so.
