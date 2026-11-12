# syntax=docker/dockerfile:1.7
# The embedder Lambda image (lane self-hosted-embeddings; one small model since DECISIONS 140, lane fix/0515-embedder-small-model). Build context: this directory (environments/embedder).
#
#   environments/embedder/tools/build-image.sh <tag>      (docker buildx build --platform linux/arm64 environments/embedder)
# Both base images are pinned by digest (tests/contract/ci-images.test.ts holds every FROM to that and to .github/ci-images.json); both digests are multi-architecture indexes that
# carry linux/arm64. Every file this Dockerfile copies is tracked in git (tests/contract/embedder-image-sources.test.ts).
#
# Stage 1 installs the build tools from requirements-build.lock (every package by sha256, installed with --require-hashes --no-deps, from PyPI only; torch by URL and hash from the PyTorch
# CPU wheels), downloads the PINNED model revisions (Hugging Face commit hashes in models.lock.json), checks every source file's sha256, exports the models to ONNX (fp32), checks every
# file the export wrote against the sha256 the lock pins, and compares the result with the original weights (parity gate). Stage 2 is the Lambda image: Python, onnxruntime, tokenizers,
# numpy (requirements-runtime.lock, --no-deps --require-hashes), the handler and the baked-in models. Nothing is downloaded after stage 1: the function works with no network at all
# (HF_HUB_OFFLINE=1; no code in the image calls out), and the stack runs it in subnets with no route out (infra/lib/embedder-function.ts).
FROM public.ecr.aws/docker/library/python:3.12-slim-bookworm@sha256:935c3c5b12357a7e10caa9c1e6ca5692344d97cf229832ef584be2cec9fc03df AS export
WORKDIR /build
ENV PIP_NO_CACHE_DIR=1 PIP_DISABLE_PIP_VERSION_CHECK=1 HF_HUB_DISABLE_TELEMETRY=1
COPY requirements-build.lock .
RUN pip install --require-hashes --no-deps --only-binary=:all: -r requirements-build.lock
COPY models.lock.json .
COPY app/embedder_core.py ./app/embedder_core.py
COPY tools/export_models.py .
RUN python export_models.py --lock models.lock.json --out /models
# Quality gate: the exported models against the reference (sentence-transformers on the original weights, fp32). Fails the build under the floor in parity_check.py. The reference files are
# checked against their sha256 in the lock before they are used.
COPY tools/parity_check.py tools/reference_snapshots.py ./
RUN python reference_snapshots.py --lock models.lock.json --out /reference \
 && python parity_check.py --models /models --reference-dir /reference --lock models.lock.json

FROM public.ecr.aws/lambda/python:3.12@sha256:238f6bfd2c1c188aff3955c2f7ceb767fe9da1b3597d84264426a11690fcf2d7
COPY requirements-runtime.lock .
RUN pip install --no-cache-dir --require-hashes --no-deps --only-binary=:all: -r requirements-runtime.lock --target "${LAMBDA_TASK_ROOT}"
COPY app/ ${LAMBDA_TASK_ROOT}/
COPY --from=export /models /opt/models
ENV EMBEDDER_MODELS_DIR=/opt/models HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 PYTHONDONTWRITEBYTECODE=1
# The image works with no network: every model file is the one the manifest names, and both names (record and lesson: one model, one copy, one a link to the other) load and embed one text each.
RUN --network=none python "${LAMBDA_TASK_ROOT}/smoke.py"
CMD ["handler.handler"]
