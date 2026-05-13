# Original Checkout Retirement

## Status

The active Symphony implementation line is `symphony-base`.

The original checkout at `/Users/ossieirondi/Projects/agents/ship-more/harness-building` was audited on 2026-05-13 and should be treated as retired source material. Do not resume development from that dirty checkout.

## Disposition

### Preserved

The original checkout contained four unique visual assets. They are now preserved under `assets/`:

| Asset | SHA-256 |
| --- | --- |
| `assets/symphony-architecture.png` | `ba7c23612b688c75aa447be1cf689c8fae5e36d21c31de4b0588e72718564dd7` |
| `assets/symphony-hero.png` | `3fe19945d47bf866a7bfa82c61f558fe54829fc01e20ded5c1bf417d406fdc8f` |
| `assets/symphony-lifecycle.png` | `44fbb0ee384fde33f9cc158b53be85a3a700914048e185f8258c4a9481367358` |
| `assets/symphony-pr-review-loop.png` | `08ba37007dc7f280431a6ba2fecfee305932eb8d3ec2376a6622bd7cc44d2326` |

### Retired

The dirty checkout source edits were older versions of work already merged into `symphony-base`:

- First-run UX files were superseded by PR #49.
- PR handoff, validation evidence, and review-loop code was superseded by the merged architecture and lifecycle slices.
- Dashboard/server stubs were superseded by PR #51.

The live GoalBuddy board files in the original checkout remain operational history, not product source. Preserve durable conclusions in normal repo docs instead of bulk-copying board HTML into the implementation line.

## Rollback

If the preserved images are later deemed unnecessary, remove only the `assets/symphony-*.png` files and this note in one docs-only PR. No runtime behavior depends on these files.
