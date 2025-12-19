# Project-local bash helpers for bloom-cover-image-editor.
# Usage:
#   source ./.bashrc
# Then:
#   y dev    -> corepack pnpm run dev

y() {
  corepack pnpm run "$@";
}

# Convenience shortcuts (optional)
ydev() { y dev; }
ybuild() { y build; }
