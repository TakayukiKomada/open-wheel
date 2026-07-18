# open-wheel release 手順

このファイルと `scripts/` は公開ソース repo には同期するが、npm tarball には含めない。
公開 repo の checkout で、publish 前に次を実行する。

```bash
pnpm test
node scripts/scrub-package.mjs
```

GameFork monorepo から確認する場合は、root で次を実行する。

```bash
pnpm --filter open-wheel test
node packages/open-wheel/scripts/scrub-package.mjs
```

scrub は `npm pack` が生成した実 tarball を展開し、allowlist 外ファイルと秘密・内部環境参照を
fail-closed で拒否する。npm publish は公開 repo の tag workflow から行い、private monorepo からは行わない。
