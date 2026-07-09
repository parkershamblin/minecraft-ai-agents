# ---- build stage -----------------------------------------------------------
FROM eclipse-temurin:21-jdk AS build
WORKDIR /workspace

# Dependency layer first: metadata-only changes don't re-download the world.
COPY gradlew gradlew.bat settings.gradle.kts build.gradle.kts ./
COPY gradle/ gradle/
RUN ./gradlew --no-daemon dependencies --quiet > /dev/null 2>&1 || true

COPY src/ src/
RUN ./gradlew --no-daemon bootJar

# ---- runtime stage ----------------------------------------------------------
FROM eclipse-temurin:21-jre
# curl for the compose healthcheck (temurin-jre ships without it)
RUN apt-get update && apt-get install -y --no-install-recommends curl \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /workspace/build/libs/*.jar app.jar
EXPOSE 8082
ENTRYPOINT ["java", "-XX:MaxRAMPercentage=75", "-jar", "app.jar"]
