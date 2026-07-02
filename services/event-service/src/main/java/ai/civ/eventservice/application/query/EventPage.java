package ai.civ.eventservice.application.query;

import ai.civ.eventservice.domain.StoredEvent;
import java.util.List;

/** One page of results; nextCursor is null on the last page. */
public record EventPage(List<StoredEvent> data, String nextCursor) {
}
