package ai.civ.governmentservice;

import java.time.Clock;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.boot.context.properties.ConfigurationPropertiesScan;
import org.springframework.context.annotation.Bean;
import org.springframework.scheduling.annotation.EnableScheduling;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

@SpringBootApplication
@EnableScheduling
@ConfigurationPropertiesScan
public class GovernmentServiceApplication {

    public static void main(String[] args) {
        SpringApplication.run(GovernmentServiceApplication.class, args);
    }

    /** Injected everywhere time is read, so tests can hold the clock still. */
    @Bean
    Clock clock() {
        return Clock.systemUTC();
    }

    /**
     * The advance loop opens one programmatic transaction PER election (a
     * poisoned row must not wedge every other election), which @Transactional
     * on a private method can't express (proxy self-invocation).
     */
    @Bean
    TransactionTemplate transactionTemplate(PlatformTransactionManager transactionManager) {
        return new TransactionTemplate(transactionManager);
    }
}
