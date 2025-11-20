FROM public.ecr.aws/lambda/nodejs:20

# 1. Install dependencies required by Chromium
# We REMOVED 'procps' because we now handle cleanup via Node.js
RUN dnf install -y \
    alsa-lib \
    at-spi2-atk \
    at-spi2-core \
    cups-libs \
    libXcomposite \
    libXcursor \
    libXdamage \
    libXext \
    libXi \
    libXtst \
    libXrandr \
    libXScrnSaver \
    libxkbcommon \
    pango \
    mesa-libgbm \
    gtk3 \
    nss \
    && dnf clean all

# 2. Set working directory
WORKDIR ${LAMBDA_TASK_ROOT}

# 3. Copy package files
COPY package.json tsconfig.json ./

# 4. Install NPM dependencies
RUN npm install

# 5. Copy source code
COPY index.ts gemini.ts ./

# 6. Build TypeScript
RUN npm run build

# 7. Set the CMD
CMD [ "dist/index.handler" ]