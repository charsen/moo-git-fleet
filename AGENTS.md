# Moo Fleet Project Rules

## Supported Viewport

- Moo Fleet is a desktop Git workbench. The supported viewport width is 1024 CSS pixels or wider.
- Mobile layouts and viewport widths below 1024 pixels are outside the product, development, testing, and release acceptance scope.
- Preserve existing small-screen styles when practical, but do not add mobile-specific features or block delivery on small-screen regressions.
- Verify user-facing UI changes at 1024 pixels and at least one wider desktop viewport such as 1440 or 1920 pixels.

## Plan-Driven Delivery

- For the branch-switching work, section 20 of `GIT-FLEET-PLAN.md` is the execution source of truth.
- Keep only one step in progress. After completing a step, update its status and progress log before starting the next step.
- When implementation differs from the plan, update the business boundary, code alignment, or API contract before continuing.
