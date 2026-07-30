# tree-sitter-d provenance

CodeGraph's vendored `tree-sitter-d.wasm` is built from:

- Repository: <https://github.com/gdamore/tree-sitter-d>
- Release: `v0.9.1`
- Commit: `64f27931b4e6fdd75af1102c79bacbca68a8dacc`
- Upstream license: MIT (`LICENSE.txt` in the upstream repository)
- Tree-sitter language ABI: 14
- Build toolchain: tree-sitter CLI 0.25.10 and Emscripten 3.1.74
- WASM SHA-256: `c5811b0fbefd94ec8f95d78e69ebae4dc7583e75cd34ac16b9600428da80f818`

Before vendoring, the grammar passed `scripts/add-lang/check-grammar.mjs`
against a representative D sample for 200 consecutive clean parses.
