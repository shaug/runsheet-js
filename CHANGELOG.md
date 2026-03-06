# Changelog

## [0.6.0](https://github.com/shaug/runsheet-js/compare/v0.5.0...v0.6.0) (2026-03-06)


### ⚠ BREAKING CHANGES

* map(), filter(), and flatMap() now accept an optional Ctx type parameter. Existing code without explicit type arguments is unaffected (defaults to StepContext).
* createPipeline has been removed. Use pipeline({ name }) to get a builder.
* createPipeline() is deprecated. Use pipeline({ name }) instead of createPipeline(name).
* RollbackError constructor now accepts an optional second parameter (causes array). Pipeline rollback handler signature changed from () => void to (ctx, output) => void.
* AggregateMeta no longer includes stepsSkipped.
* buildPipeline renamed to pipeline. PipelineResult, PipelineMeta, PipelineSuccess, PipelineFailure, TypedPipeline renamed to AggregateResult, AggregateMeta, AggregateSuccess, AggregateFailure, AggregateStep.
* StepMeta no longer has stepsExecuted/stepsSkipped. buildPipeline() returns TypedPipeline instead of TypedStep. StepResult replaces the previous Result type from composable-functions.

### Features

* remove createPipeline, use pipeline({ name }) instead ([2ed0be1](https://github.com/shaug/runsheet-js/commit/2ed0be1e7812179d5d9d01483d1bb08c57b7c5e6))
* rename to AggregateResult/AggregateStep, buildPipeline to pipeline ([89f93e4](https://github.com/shaug/runsheet-js/commit/89f93e4fa45477b26cf72f52744b8a42d2a9ef20))
* typecheck test files, fix type errors, remove stepsSkipped ([b609879](https://github.com/shaug/runsheet-js/commit/b6098790884823f238e2e726a412eea8e17c4f32))
* unify execution model, add PipelineResult and TypedPipeline ([df62975](https://github.com/shaug/runsheet-js/commit/df629753107b2a360be0f5225984c6b7e3d7a4a5))
* unify pipeline() to return builder when steps is omitted ([0205d2a](https://github.com/shaug/runsheet-js/commit/0205d2aab6ef55815bd998272ece0d88fdb53594))


### Bug Fixes

* address principal review findings ([b70b7aa](https://github.com/shaug/runsheet-js/commit/b70b7aadd858edf899a5b8031fe7447cc60715b4))
* pipeline reentrancy, parallel rollback scope, and review findings ([32e2c3a](https://github.com/shaug/runsheet-js/commit/32e2c3a880ac2da10bb75e6b1c1cb71fffc47ba8))


### Miscellaneous Chores

* target 0.6.0 for next release ([9f9bb73](https://github.com/shaug/runsheet-js/commit/9f9bb73256908273f05618d62b6d1e081d782d23))

## [0.5.0](https://github.com/shaug/runsheet-js/compare/v0.4.0...v0.5.0) (2026-03-06)


### Features

* add choice() combinator for conditional branching ([825a001](https://github.com/shaug/runsheet-js/commit/825a001eaf25aa2e84e089ade8af08ece28b8697))
* add filter() combinator for collection filtering ([fba3251](https://github.com/shaug/runsheet-js/commit/fba325138d23b69bbd0f4708cfbde9c94cbb6a53))
* add flatMap() combinator for collection expansion ([41e30b3](https://github.com/shaug/runsheet-js/commit/41e30b3109fde7178c1783c5fa204d54db2927e3))
* add map() combinator for collection iteration ([ff4cdd1](https://github.com/shaug/runsheet-js/commit/ff4cdd1aefa07d9fa3d3619e6ca1ab1139c88290))
* support bare step as default in choice() ([3de6c8b](https://github.com/shaug/runsheet-js/commit/3de6c8b7d3f3cee6b71630706e1ee3b93eb4a5c2))

## [0.4.0](https://github.com/shaug/runsheet-js/compare/v0.3.1...v0.4.0) (2026-03-06)


### Features

* add parallel() combinator for concurrent step execution ([2997502](https://github.com/shaug/runsheet-js/commit/2997502d770f2ddcc47935150f1dd5776bcc5a39))


### Bug Fixes

* **ci:** use Node 24 and NPM_CONFIG_PROVENANCE for trusted publishers ([463b350](https://github.com/shaug/runsheet-js/commit/463b3503f81a327fbd8d18e93aa373003fa85a62))

## [0.3.1](https://github.com/shaug/runsheet-js/compare/v0.3.0...v0.3.1) (2026-03-06)


### Bug Fixes

* **ci:** add environment and provenance for npm trusted publishers ([f216901](https://github.com/shaug/runsheet-js/commit/f216901862c28f8ca7d7ee6c790087769e6be014))

## [0.3.0](https://github.com/shaug/runsheet-js/compare/v0.2.1...v0.3.0) (2026-03-06)


### Features

* add strict mode for provides key collision detection ([cd12eba](https://github.com/shaug/runsheet-js/commit/cd12eba2d4f632021fe1bef5b29152bbbbb643bb))

## [0.2.1](https://github.com/shaug/runsheet-js/compare/v0.2.0...v0.2.1) (2026-03-06)


### Bug Fixes

* **ci:** fix npm trusted publisher OIDC auth ([e042b75](https://github.com/shaug/runsheet-js/commit/e042b75cc0918bb63a5e62d63f1dcd9c756bff35))
* **ci:** match npm trusted publisher sample workflow ([9f0da81](https://github.com/shaug/runsheet-js/commit/9f0da8135268768c624d586f1145cf27e15969ba))
* **ci:** restore registry-url for trusted publisher OIDC ([0281bc8](https://github.com/shaug/runsheet-js/commit/0281bc87dc0ffd4b14390f24ed16ec6280b27f82))

## [0.2.0](https://github.com/shaug/runsheet-js/compare/v0.1.0...v0.2.0) (2026-03-05)


### Features

* add retry and timeout options to defineStep ([6359d62](https://github.com/shaug/runsheet-js/commit/6359d627c4bc5706f6d38845d2fc2ba97cbe7682))

## 0.1.0 (2026-03-05)


### Features

* initial implementation of runsheet pipeline library ([9426064](https://github.com/shaug/runsheet-js/commit/94260648eb983eac37732c35ae7cc0282a8c0b41))


### Bug Fixes

* **ci:** skip lint and format on Node 18 ([0b29081](https://github.com/shaug/runsheet-js/commit/0b29081e38a31d45a766efeb096b947cdb6517e2))


### Miscellaneous Chores

* release 0.1.0 ([e992c8c](https://github.com/shaug/runsheet-js/commit/e992c8cae0da77f72de0a43063935820dadf1737))

## Changelog
