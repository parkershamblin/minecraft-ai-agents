package ai.civ.eventservice.application.query;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.time.OffsetDateTime;
import java.util.UUID;
import org.junit.jupiter.api.Test;

class CursorTest {

    @Test
    void roundTripsThroughBase64() {
        Cursor original = new Cursor(
                OffsetDateTime.parse("2026-07-02T18:41:08.412Z"),
                UUID.fromString("019f8e2b-0004-7000-8000-00000000a004"));

        Cursor decoded = Cursor.decode(original.encode());

        assertThat(decoded).isEqualTo(original);
    }

    @Test
    void rejectsMalformedCursors() {
        assertThatThrownBy(() -> Cursor.decode("not-a-cursor"))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("malformed cursor");
    }
}
