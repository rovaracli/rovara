# The handler of the runner client's live test (slice 4, lane W3): a Python function with numpy, as a customer would write it. Events: {"op":"raise"} raises ValueError, {"op":"sleep","s":N} sleeps.
import os
import time

import numpy as np


def handler(event, context):
    if isinstance(event, dict) and event.get("op") == "raise":
        raise ValueError("boom from numpy_app")
    if isinstance(event, dict) and event.get("op") == "sleep":
        time.sleep(float(event.get("s", 1)))
    a = np.arange(1_000_000, dtype=np.float64).reshape(1000, 1000)
    return {"sum": float(np.arange(10).sum()), "dot": float((a @ a.T)[0, 0]), "numpy": np.__version__, "arch": os.uname().machine, "fn": context.function_name, "echo": event}
