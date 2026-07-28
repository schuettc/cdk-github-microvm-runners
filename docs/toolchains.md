# Toolchains

A runner VM boots from an image you build, and
[`actions/setup-python`](https://github.com/actions/setup-python) and
[`actions/setup-node`](https://github.com/actions/setup-node) resolve the
version a job asks for from that image's hosted tool cache. Declaring
toolchains is how versions get into that cache, so a workflow's `setup-*` steps
work the way they do on a GitHub-hosted runner.

A toolchain is specifically a language runtime placed in the tool cache for
those actions to find, and `RunnerToolchain` installs two: Python and Node.
Software a job invokes directly, rather than through a `setup-*` action, goes
into an image through `RunnerImage`'s `systemPackages`, `setupCommands`, and
`assets` options, which [Runner images](images.md) covers along with how images
are built and how large they can be.

## Declaring a toolchain

`RunnerToolchain` has two methods:

```ts
RunnerToolchain.python('3.12.7');
RunnerToolchain.node('22.11.0');
```

Pass them to a `RunnerImage`, and give that image to the runner class whose
jobs need them:

```ts
runners.addRunnerClass('microvm', {
  size: MicrovmSize.GB4,
  image: RunnerImage.fromOptions({
    toolchains: [
      RunnerToolchain.python('3.12.7'),
      RunnerToolchain.node('22.11.0'),
    ],
  }),
});
```

A workflow that targets that class then uses `setup-*` as written:

```yaml
runs-on: [self-hosted, microvm]
steps:
  - uses: actions/setup-python@v7
    with:
      python-version: '3.12'
```

`toolchains` defaults to an empty list, so an image carries the versions it
names. Declare them per runner class, for the versions that class's workflows
use.

## Versions

Each toolchain pins a full three-part semver, because the version names the
cache directory it is baked into — `/opt/hostedtoolcache/Python/3.12.7/arm64`.
A partial version throws at synth time:

```
RunnerToolchain: version must be a full semver like '3.12.7', got '3.12'.
```

Several versions of the same language live in one image, each in its own
directory:

```ts fragment=RunnerImageOptions
toolchains: [
  RunnerToolchain.python('3.11.9'),
  RunnerToolchain.python('3.12.7'),
  RunnerToolchain.node('20.18.0'),
  RunnerToolchain.node('22.11.0'),
],
```

A workflow's version selector is a semver range, so `python-version: '3.12'`
resolves to the baked `3.12.7` and `node-version: '20'` to the baked `20.18.0`.

Moving from `3.12.6` to `3.12.7` is an edit to the version string. That changes
the rendered Dockerfile and with it the image's content hash, which builds a new
image version, the same as any other change to `RunnerImage.fromOptions()`'s
options.

## When a workflow asks for a version the image does not carry

Both actions read the tool cache first and otherwise resolve the version from
GitHub's published builds, and they differ in what is published for the
runner's architecture.

`actions/python-versions` publishes no linux-arm64 builds, so a Python version
the image does not carry ends the job at that step:

```
The version '3.12' with architecture 'arm64' was not found for this
operating system
```

Bake every Python version your workflows request.

`actions/node-versions` does publish linux-arm64 builds, so `setup-node`
downloads a Node version the image does not carry and the job runs on it. That
costs about 24 seconds, and since each job gets its own VM, the download
repeats on every job that asks for an un-baked version rather than accumulating
in a shared cache. Bake the Node versions your workflows use when you would
rather not pay that each time.

Several baked versions add up against the image's disk allowance;
[Runner images](images.md) covers the budget and how to fit inside it.
