# Source provenance

The repository was restored from the public npm archive for `omni-skills-forge@2.1.1`. The package’s former GitHub repository was unavailable during restoration. The first commit in this repository records the recovered archive snapshot. Original Git history was unavailable.

| Archive property | Value |
| --- | --- |
| npm package | `omni-skills-forge@2.1.1` |
| Integrity | `sha512-9D2bXMUOpkfEi8NFugoVsnz7SamzgqfO07b3AyXGt/laRBhHk7IGPWL2KRQcdTTjo95szQ8qZqouzQqBUhirdg==` |
| Archive files | 50,020 |
| Shipped Markdown skill files | 50,009 |
| Registry entries | 50,009 |
| Registry category paths | 28 |
| Initial restoration commit | `a93dbcd0` |

[npm package](https://www.npmjs.com/package/omni-skills-forge/v/2.1.1) · [Registry tarball](https://registry.npmjs.org/omni-skills-forge/-/omni-skills-forge-2.1.1.tgz)

The archive contains the CLI, installer, dashboard, doctor, skill files, master registry, and `scripts/build-registry.js`. Every registry file reference corresponds to a shipped Markdown file. The archive excludes `scripts/generate-skills.js`. That historical generator cannot be restored from this snapshot. The available builder can reindex the included files with `npm run build-registry`.

The installer target table describes the implemented file layouts. Loading a copied file depends on the client and version in use. The archive establishes what was published and where the CLI copies it. Native client activation is a separate check.

See [Catalog categories](CATEGORIES.md) for the breakdown and the [README](../README.md) for explicit-directory examples.
