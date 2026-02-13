# syntax=docker/dockerfile:1

# Stage 1: Install Claude Code
FROM archlinux:latest AS claude-code-installer
RUN --mount=type=cache,target=/var/cache/pacman/pkg \
	pacman -Syu --noconfirm curl
RUN curl -fsSL https://claude.ai/install.sh | bash

# Stage 2: Build yay
FROM archlinux:latest AS yay-builder
RUN --mount=type=cache,target=/var/cache/pacman/pkg \
	pacman -Syu --noconfirm base-devel git
RUN useradd -m -G wheel builder && \
	echo '%wheel ALL=(ALL) NOPASSWD: ALL' >> /etc/sudoers && \
	su - builder -c 'git clone https://aur.archlinux.org/yay.git && cd yay && makepkg -si --noconfirm'

# Stage 3: Main image
FROM archlinux:latest AS main

# Build arguments for user configuration
ARG USER_ID=1000
ARG USERNAME=claude

# Install system dependencies (as root)
RUN --mount=type=cache,target=/var/cache/pacman/pkg \
	pacman -Syu --noconfirm git bash base-devel sudo ripgrep fd jq openssh socat nodejs

# Install official repo packages from PACKAGES early (while yay builds in parallel)
ARG PACKAGES=""
RUN --mount=type=cache,target=/var/cache/pacman/pkg \
	set -xe; \
	if [ -n "${PACKAGES}" ]; then \
		OFFICIAL_PKGS=$(echo "${PACKAGES}" | tr ' ' '\n' | grep -Fxf <(pacman -Slq) | tr '\n' ' '); \
		if [ -n "${OFFICIAL_PKGS}" ]; then \
			pacman -S --noconfirm ${OFFICIAL_PKGS}; \
		fi; \
	fi

# Copy yay from builder stage
COPY --from=yay-builder /usr/bin/yay /usr/bin/yay

# Install remaining (AUR) packages with yay (skips already-installed official packages)
RUN --mount=type=cache,target=/var/cache/pacman/pkg \
	--mount=type=cache,target=/tmp/yay-build \
	set -xe; \
	if [ -n "${PACKAGES}" ]; then \
		useradd -m -G wheel builder; \
		echo '%wheel ALL=(ALL) NOPASSWD: ALL' >> /etc/sudoers; \
		chmod 777 /tmp/yay-build; \
		su - builder -c "yay -S --noconfirm --builddir /tmp/yay-build ${PACKAGES}"; \
		userdel -r builder; \
		sed -i '/%wheel ALL=(ALL) NOPASSWD: ALL/d' /etc/sudoers; \
	fi

# Copy Claude Code installation from first stage
COPY --from=claude-code-installer /root/.local/bin/claude /opt/claude-code/.local/bin/claude
COPY --from=claude-code-installer /root/.local/share/claude /opt/claude-code/.local/share/claude

# Create non-root user WITHOUT sudo access
RUN set -xe; \
	useradd -m -u ${USER_ID} ${USERNAME}; \
	mkdir -p /home/${USERNAME}/.config /home/${USERNAME}/.local/bin /home/${USERNAME}/.local/share; \
	chown -R ${USERNAME}:${USERNAME} /home/${USERNAME}

# Switch to non-root user (no sudo from this point)
USER ${USERNAME}
ENV PATH="/opt/claude-code/.local/bin:/home/${USERNAME}/.local/bin:${PATH}"
