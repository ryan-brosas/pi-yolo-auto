# Third-Party Notices

This project's runtime uses only Node.js built-ins plus pi's own registry
(`@earendil-works/pi-coding-agent`, a peer dependency provided by the host, in
`peerDependencies`). No third-party npm packages are bundled at runtime.

The project's provider architecture was adapted from
[pi-crof-provider](https://github.com/monotykamary/pi-crof-provider) (MIT) by
monotyk — see `index.ts` header and AGENTS.md for the porting notes.

## Development-time dependencies

| Package | License |
|---------|---------|
| typescript (devDependency) | Apache-2.0 |
