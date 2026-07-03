"""The Memory bounded context — a generative-agents memory stream.

In-process module over its own logical database (memory_db); the public
surface below mirrors the future REST contract exactly (store/search/reflect),
so the M1 extraction to a standalone memory-service is mechanical.
"""

from agent_service.memory.service import MemoryRecord, MemoryService, RetrievedMemory

__all__ = ["MemoryService", "MemoryRecord", "RetrievedMemory"]
