plugins {
    java
    jacoco
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

// M2-10: the coverage gate, ON, scoped like event-service's (M1-10 pattern):
// REST + Kafka in-adapters, the application core, and the JDBC stores they
// share — one aggregate ratio (measured 92.3% at gate time). config/, domain
// records, the Kafka out-adapter (the SSE-relay analog) and the boot class
// stay measured-but-ungated.
jacoco { toolVersion = "0.8.12" }

private fun org.gradle.api.tasks.SourceSetContainer.gatedClasses() =
    getByName("main").output.asFileTree.matching {
        include(
            "ai/civ/governmentservice/adapter/in/**",
            "ai/civ/governmentservice/application/**",
            "ai/civ/governmentservice/adapter/out/persistence/**",
        )
    }

tasks.jacocoTestReport {
    dependsOn(tasks.test)
    reports { csv.required.set(true) }
}

tasks.jacocoTestCoverageVerification {
    dependsOn(tasks.test)
    classDirectories.setFrom(sourceSets.gatedClasses())
    violationRules {
        rule {
            limit {
                counter = "LINE"
                value = "COVEREDRATIO"
                minimum = "0.80".toBigDecimal()
            }
        }
    }
}

// `test` alone enforces the gate — CI's fixed `gradlew test bootJar` needs no change.
tasks.test { finalizedBy(tasks.jacocoTestCoverageVerification) }
