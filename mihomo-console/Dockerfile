ARG MIHOMO_IMAGE=docker.io/metacubex/mihomo:v1.19.30
FROM ${MIHOMO_IMAGE} AS mihomo

FROM python:3.13-alpine

LABEL org.opencontainers.image.source="https://github.com/silencoo/script-toolbox"
LABEL org.opencontainers.image.description="Mihomo core with Mihomo Console subscription management"

RUN apk add --no-cache ca-certificates tzdata

COPY --from=mihomo /mihomo /usr/local/bin/mihomo
COPY --from=mihomo /root/.config/mihomo/ /usr/local/share/mihomo/
COPY requirements.txt /tmp/requirements.txt
RUN python -m pip install --no-cache-dir -r /tmp/requirements.txt \
    && rm /tmp/requirements.txt

RUN install -d -m 0755 /usr/local/lib/mihomo-console
COPY --chmod=0755 mihomo_console.py /usr/local/sbin/mihomo-console
COPY --chmod=0755 container_runtime.py /usr/local/lib/mihomo-console/container_runtime.py
COPY mihomo_console.py /usr/local/lib/mihomo-console/mihomo_console.py
RUN sed -i 's/\r$//' \
    /usr/local/sbin/mihomo-console \
    /usr/local/lib/mihomo-console/container_runtime.py \
    /usr/local/lib/mihomo-console/mihomo_console.py

VOLUME ["/data"]
EXPOSE 7890 9090

ENV MIHOMO_MANAGER_CONFIG=/data/manager/subscription-manager.json

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD ["python", "/usr/local/lib/mihomo-console/container_runtime.py", "healthcheck"]

ENTRYPOINT ["python", "/usr/local/lib/mihomo-console/container_runtime.py"]
CMD ["run"]
