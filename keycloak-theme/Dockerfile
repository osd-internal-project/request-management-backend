# Base is the SAME already-mirrored, already-verified-amd64 image the install
# chart uses (chart/keycloak/values-sit.yaml) — not docker.io/keycloak/keycloak
# directly. Building from the public image here would silently reintroduce the
# arm64/amd64 mismatch worked around on 11 Sep 2026 (see that chart's own
# comment) for anyone who builds this on Apple Silicon, which is likely: theme
# work is exactly the kind of change made locally on a laptop.
FROM swr.ap-southeast-2.myhuaweicloud.com/osd-internal/request-management-keycloak:26.5.2-amd64
COPY ./request-management /opt/keycloak/themes/request-management
