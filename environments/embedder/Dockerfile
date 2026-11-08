# syntax=docker/dockerfile:1.7
# The embedder Lambda image (lane self-hosted-embeddings). Build context: this directory (environments/embedder).
#
#   environments/embedder/build/build-image.sh <tag>      (docker buildx build --platform linux/arm64 environments/embedder)
# Both base images are pinned by digest (tests/contract/ci-images.test.ts holds every FROM to that and to .github/ci-images.json).
#
# Stage 1 downloads the PINNED model revisions (Hugging Face commit hashes in models.lock.json), checks every source file's sha256, exports
# the models to ONNX, quantizes the Qwen model to int8 and checks the result against the original weights. Stage 2 is the Lambda image: Python,
# onnxruntime, tokenizers, numpy, the handler and the baked-in models. Nothing is downloaded after stage 1: the function has no network
# access need at run time and works with none (HF_HUB_OFFLINE=1; no code in the image calls out).
FROM public.ecr.aws/docker/library/python:3.12-slim-bookworm@sha256:935c3c5b12357a7e10caa9c1e6ca5692344d97cf229832ef584be2cec9fc03df AS export
WORKDIR /build
ENV PIP_NO_CACHE_DIR=1 PIP_DISABLE_PIP_VERSION_CHECK=1 HF_HUB_DISABLE_TELEMETRY=1
COPY requirements-build.txt .
RUN pip install --extra-index-url https://download.pytorch.org/whl/cpu -r requirements-build.txt
COPY models.lock.json .
COPY app/embedder_core.py ./app/embedder_core.py
COPY build/export_models.py .
RUN python export_models.py --lock models.lock.json --out /models
# Quality gate: the exported models against the reference (sentence-transformers on the original weights). Fails the build under the floor
# in parity_check.py. The reference needs sentence-transformers, which stays in this stage.
COPY build/parity_check.py build/reference_snapshots.py ./
RUN pip install "sentence-transformers==6.2.0" \
 && python reference_snapshots.py --lock models.lock.json --out /reference \
 && python parity_check.py --models /models --reference-dir /reference --lock models.lock.json

FROM public.ecr.aws/lambda/python:3.12@sha256:238f6bfd2c1c188aff3955c2f7ceb767fe9da1b3597d84264426a11690fcf2d7
COPY requirements-runtime.txt .
RUN pip install --no-cache-dir -r requirements-runtime.txt --target "${LAMBDA_TASK_ROOT}"
COPY app/ ${LAMBDA_TASK_ROOT}/
COPY --from=export /models /opt/models
ENV EMBEDDER_MODELS_DIR=/opt/models HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 PYTHONDONTWRITEBYTECODE=1
# The image works with no network: load both models and embed one text each.
RUN --network=none python "${LAMBDA_TASK_ROOT}/smoke.py"
CMD ["handler.handler"]
