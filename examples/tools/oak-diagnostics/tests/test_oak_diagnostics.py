import importlib.util
import io
import json
import math
import sys
import unittest
from contextlib import redirect_stderr
from pathlib import Path


MODULE_PATH = Path(__file__).parents[1] / "oak_diagnostics.py"
SPEC = importlib.util.spec_from_file_location("oak_diagnostics", MODULE_PATH)
oak = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
sys.modules[SPEC.name] = oak
SPEC.loader.exec_module(oak)


class Transform:
    def __init__(self, matrix):
        self.matrix = matrix

    def getIntrinsicMatrix(self):
        return self.matrix


class VectorMask:
    def mean(self):
        return 0.5


class VectorDepth:
    size = 6

    def __gt__(self, value):
        self.compared_to = value
        return VectorMask()


class OakDiagnosticsTests(unittest.TestCase):
    def test_profile_resolution(self):
        self.assertEqual(oak.resolve_profile("full"), {
            "profile": "full", "width": 1280, "height": 720, "fps": 30.0,
        })
        self.assertEqual(oak.resolve_profile("balanced"), {
            "profile": "balanced", "width": 960, "height": 540, "fps": 25.0,
        })
        self.assertEqual(oak.resolve_profile("compact"), {
            "profile": "compact", "width": 640, "height": 360, "fps": 25.0,
        })
        self.assertEqual(oak.parse_args([]).profile, "balanced")
        full = oak.parse_args(["--profile", "full"])
        self.assertEqual((full.width, full.height, full.fps), (1280, 720, 30.0))
        with self.assertRaises(ValueError):
            oak.resolve_profile("unknown")

    def test_display_layout_caps_tiles_and_preserves_aspect_ratio(self):
        self.assertEqual(oak.letterbox_size((1920, 1080)), (640, 360))
        self.assertEqual(oak.letterbox_size((640, 480)), (480, 360))
        self.assertLessEqual(oak.letterbox_size((640, 480))[0], 640)
        self.assertLessEqual(oak.letterbox_size((640, 480))[1], 360)
        self.assertEqual(oak.display_layout_size(), (1280, 720))

    def test_sync_threshold(self):
        self.assertEqual(oak.sync_threshold_ms(25.0), 20.0)
        with self.assertRaises(ValueError):
            oak.sync_threshold_ms(0)

    def test_device_and_usb_display(self):
        self.assertEqual(oak.display_device_id("18443010A1B2C3D4"), "A1B2C3D4")
        self.assertEqual(oak.redact_device_text("native device 18443010A1B2C3D4 connected"), "native device ...A1B2C3D4 connected")
        self.assertEqual(oak.usb_link_status("UsbSpeed.SUPER")["level"], "PASS")
        self.assertEqual(oak.usb_link_status("UsbSpeed.HIGH")["level"], "FAIL")
        self.assertEqual(oak.usb_link_status("UsbSpeed.UNKNOWN")["level"], "WARN")

    def test_intrinsics_validation(self):
        valid = oak.finite_intrinsics(Transform([[800, 0, 640], [0, 801, 360], [0, 0, 1]]), 1280, 720)
        self.assertEqual(valid["fy"], 801.0)
        self.assertIsNone(oak.finite_intrinsics(Transform([[math.nan, 0, 1], [0, 1, 1], [0, 0, 1]]), 2, 2))

    def test_depth_statistics(self):
        depth = [[0, 0, 0], [0, 1500, 1600], [0, 1400, 0]]
        self.assertEqual(oak.median_depth_stats(depth, 1, 1, 1), (1500, 3, 9))
        self.assertEqual(oak.valid_depth_ratio(depth), 1 / 3)

    def test_vector_depth_ratio_uses_array_mean(self):
        depth = VectorDepth()
        self.assertEqual(oak.valid_depth_ratio(depth), 0.5)
        self.assertEqual(depth.compared_to, 0)

    def test_frame_validation(self):
        checks = oak.validate_frame((1280, 720), (1280, 720), {"fx": 1}, 4.0, 5.0, 0.2, 0.1)
        self.assertTrue(all(checks.values()))
        failed = oak.validate_frame((1, 1), (2, 1), None, 6.0, 5.0, 0.0, 0.1)
        self.assertFalse(any(failed.values()))


class OakIsolationTests(unittest.TestCase):
    def test_isolation_cli_accepts_requested_stages_and_matrix_labels(self):
        args = oak.parse_args([
            "--isolate", "--stages", "discover,health,rgb", "--attempts", "2", "--frames", "3", "--json",
            "--mxid", "18443010A1B2C3D4", "--host", "workstation-a", "--cable", "rear-usb-c",
            "--power", "direct", "--setup", "desk-1",
        ])
        self.assertEqual(args.stages, ("discover", "health", "rgb"))
        self.assertEqual(args.attempts, 2)
        self.assertEqual(args.frames, 3)
        self.assertEqual(args.setup, {"host": "workstation-a", "cable": "rear-usb-c", "power": "direct", "label": "desk-1"})

    def test_isolation_cli_records_viewer_failure_evidence(self):
        self.assertTrue(oak.parse_args(["--isolate", "--viewer-failed"]).viewer_failed)

    def test_isolation_defaults_to_lightweight_stages_before_health(self):
        self.assertEqual(oak.parse_args(["--isolate"]).stages, ("discover", "rgb", "stereo", "rgbd", "health"))

    def test_hidden_worker_cli_parse(self):
        args = oak.parse_args([
            "--_isolation-worker", "--worker-stage", "stereo", "--worker-attempt", "2",
            "--worker-result", "worker.json", "--attempt-timeout-seconds", "90",
        ])
        self.assertTrue(args.isolation_worker)
        self.assertEqual((args.worker_stage, args.worker_attempt, args.worker_result.name), ("stereo", 2, "worker.json"))

    def test_worker_command_keeps_inner_and_outer_timeouts_distinct(self):
        args = oak.parse_args(["--isolate", "--timeout-seconds", "30", "--attempt-timeout-seconds", "90"])
        command = oak.worker_command(args, "rgb", 1, Path("worker.json"))
        self.assertEqual(command[command.index("--timeout-seconds") + 1], "30.0")
        self.assertEqual(command[command.index("--attempt-timeout-seconds") + 1], "90.0")

    def test_isolation_rejects_unknown_or_duplicate_stages(self):
        with redirect_stderr(io.StringIO()):
            with self.assertRaises(SystemExit):
                oak.parse_args(["--isolate", "--stages", "rgb,unknown"])
            with self.assertRaises(SystemExit):
                oak.parse_args(["--isolate", "--stages", "rgb,rgb"])

    def test_classification_reports_usb2_as_host_path_not_device_failure(self):
        report = oak.make_isolation_report([oak.stage_result("rgb", 1, usb_speed="HIGH", error="RGB failed")])
        verdict = oak.classify_isolation(report)
        self.assertEqual(verdict["classification"], "USB_OR_POWER_OR_HOST")
        self.assertIn("USB 2", " ".join(verdict["reasons"]))

    def test_classification_reports_rgb_failure_as_inconclusive(self):
        report = oak.make_isolation_report([oak.stage_result("rgb", 1, error="camera did not produce frames")])
        self.assertEqual(oak.classify_isolation(report)["classification"], "INCONCLUSIVE")

    def test_classification_reports_second_stereo_x_link_restart_failure(self):
        report = oak.make_isolation_report([
            oak.stage_result("stereo", 1),
            oak.stage_result("stereo", 2, error="X_LINK_ERROR: device disconnected"),
        ])
        verdict = oak.classify_isolation(report)
        self.assertEqual(verdict["classification"], "DEPTHAI_STEREO_RESTART")
        self.assertTrue(report["stages"][1]["xLink"])

    def test_normal_ir_driver_health_issue_is_recorded_without_device_failure(self):
        report = oak.make_isolation_report([
            oak.stage_result("health", 1, health={"issues": ["No IR drivers detected"]}),
        ])
        self.assertEqual(oak.classify_isolation(report)["classification"], "PASS")

    def test_classification_reports_camera_health_failure_as_device_or_firmware(self):
        report = oak.make_isolation_report([
            oak.stage_result("health", 1, health={"issues": [], "cameraFunctionality": "FAIL"}),
        ])
        self.assertEqual(oak.classify_isolation(report)["classification"], "DEVICE_OR_FIRMWARE")

    def test_classification_reports_power_health_failure_as_host_path(self):
        report = oak.make_isolation_report([
            oak.stage_result("health", 1, health={"issues": [], "powerSupplyFunctionality": "ERROR"}),
        ])
        self.assertEqual(oak.classify_isolation(report)["classification"], "USB_OR_POWER_OR_HOST")

    def test_initial_stereo_x_link_failure_is_not_restart_evidence(self):
        report = oak.make_isolation_report([
            oak.stage_result("stereo", 1, error="X_LINK_ERROR: device disconnected"),
            oak.stage_result("stereo", 2, error="X_LINK_ERROR: device disconnected"),
        ])
        self.assertEqual(oak.classify_isolation(report)["classification"], "INCONCLUSIVE")

    def test_clean_isolation_with_viewer_failure_is_viewer_or_app(self):
        report = oak.make_isolation_report([oak.stage_result("rgb", 1)], viewer_failed=True)
        self.assertEqual(oak.classify_isolation(report)["classification"], "VIEWER_OR_APP")

    def test_cleanup_error_does_not_replace_the_original_stage_exception(self):
        result = oak.stage_result("stereo", 2, error="X_LINK_ERROR: disconnect")
        oak.record_cleanup_error(result, RuntimeError("close failed"), "18443010A1B2C3D4")
        self.assertEqual(result["exception"]["message"], "X_LINK_ERROR: disconnect")
        self.assertEqual(result["cleanupException"]["message"], "close failed")

    def test_child_timeout_keeps_redacted_logs_in_a_valid_partial_report(self):
        result = oak.finish_child_attempt(
            "rgb", 1, None, stdout="DepthAI 18443010A1B2C3D4\n", stderr="X_LINK ping missed\n", timed_out=True,
            device_id="18443010A1B2C3D4",
        )
        self.assertEqual(result["exception"]["type"], "TimeoutExpired")
        self.assertTrue(result["xLink"])
        self.assertNotIn("18443010A1B2C3D4", json.dumps(result))
        report_path = MODULE_PATH.parent / ".test-oak-report.json"
        try:
            oak.atomic_write_json(report_path, oak.make_isolation_report([result], device_id="18443010A1B2C3D4"))
            self.assertEqual(json.loads(report_path.read_text(encoding="utf-8"))["stages"][0]["exception"]["type"], "TimeoutExpired")
        finally:
            report_path.unlink(missing_ok=True)

    def test_native_nonzero_with_log_mixing_becomes_exception_result(self):
        worker = oak.stage_result("stereo", 2)
        result = oak.finish_child_attempt(
            "stereo", 2, worker, stdout="native log\n{not json}\n", stderr="X_LINK_DEVICE_NOT_FOUND\n",
            returncode=134, device_id="18443010A1B2C3D4",
        )
        self.assertEqual(result["exception"]["type"], "ChildProcessError")
        self.assertTrue(result["xLink"])
        self.assertIn("{not json}", result["childLogs"]["stdout"])

    def test_child_without_result_file_becomes_exception_result(self):
        result = oak.finish_child_attempt("health", 1, None, stdout="native log", returncode=0)
        self.assertEqual(result["exception"]["type"], "WorkerResultMissing")

    def test_all_passing_stages_are_pass_and_report_is_redacted_schema(self):
        report = oak.make_isolation_report([
            oak.stage_result("discover", 1), oak.stage_result("health", 1, health={"issues": []}),
            oak.stage_result("rgb", 1), oak.stage_result("stereo", 1), oak.stage_result("rgbd", 1),
        ], device_id="18443010A1B2C3D4")
        verdict = oak.classify_isolation(report)
        self.assertEqual(verdict["classification"], "PASS")
        self.assertEqual(report["schemaVersion"], 1)
        self.assertEqual(report["device"]["id"], "A1B2C3D4")
        self.assertEqual(set(("runId", "time", "python", "depthai", "os", "setup", "device", "stages", "viewerObservedFailure", "verdict")),
                         set(report) - {"schemaVersion"})


if __name__ == "__main__":
    unittest.main()
