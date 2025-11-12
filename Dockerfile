FROM archlinux:latest

# Build arguments for user configuration
ARG USER_ID=1000
ARG USERNAME=claude

# Install system dependencies
RUN pacman -Syu --noconfirm git bash nodejs npm base-devel sudo ripgrep fd jq

# Install yay
RUN set -xe; \
    useradd -m -G wheel builder; \
    echo '%wheel ALL=(ALL) NOPASSWD: ALL' >> /etc/sudoers; \
    su - builder -c 'git clone https://aur.archlinux.org/yay.git && cd yay && makepkg -si --noconfirm'; \
    userdel -r builder

# Install Claude Code CLI
RUN npm install -g @anthropic-ai/claude-code

# Create non-root user
RUN set -xe; \
    useradd -m -u ${USER_ID} -G wheel ${USERNAME}; \
    mkdir -p /home/${USERNAME}/.config /home/${USERNAME}/.local/bin /home/${USERNAME}/.local/share; \
    chown -R ${USERNAME}:${USERNAME} /home/${USERNAME}

# Switch to non-root user
USER ${USERNAME}

# Install AUR packages if specified
ARG PACKAGES=""
RUN if [ -n "${PACKAGES}" ]; then \
    yay -S --noconfirm ${PACKAGES}; \
    fi

# Disable sudo for user
USER root
RUN gpasswd -d ${USERNAME} wheel || true
USER ${USERNAME}
