plugins {
    java
    id("org.springframework.boot") version "3.5.6"
    id("io.spring.dependency-management") version "1.1.7"
}

group = "ai.civ"
version = "0.1.0"

// Host JDKs vary (this dev box runs 25); we target 21 bytecode without
// requiring a second JDK install. CI pins temurin-21, so both stay honest.
tasks.withType<JavaCompile> { options.release.set(21) }

repositories { mavenCentral() }

dependencies {
    implementation("org.springframework.boot:spring-boot-starter-web")
    implementation("org.springframework.boot:spring-boot-starter-actuator")
    implementation("org.springframework.boot:spring-boot-starter-jdbc")
    implementation("org.springframework.boot:spring-boot-starter-validation")
    implementation("org.springframework.kafka:spring-kafka")
    implementation("org.flywaydb:flyway-database-postgresql")
    implementation("io.micrometer:micrometer-registry-prometheus")
    implementation("org.springdoc:springdoc-openapi-starter-webmvc-ui:2.7.0")
    implementation("net.logstash.logback:logstash-logback-encoder:8.0")
    runtimeOnly("org.postgresql:postgresql")

    testImplementation("org.springframework.boot:spring-boot-starter-test")
    testImplementation("org.testcontainers:junit-jupiter")
    testImplementation("org.testcontainers:postgresql")
    testImplementation("org.testcontainers:redpanda")
    testImplementation("org.awaitility:awaitility")
}

dependencyManagement {
    imports { mavenBom("org.testcontainers:testcontainers-bom:1.21.3") }
}

tasks.withType<Test> {
    useJUnitPlatform()
    testLogging { events("passed", "failed", "skipped") }
    // Docker Engine 29+ (Desktop 4.80) requires client API >= 1.44; docker-java's
    // default is older and gets HTTP 400 from the npipe. Engines >= 25 all accept 1.44.
    systemProperty("api.version", "1.44")
}
