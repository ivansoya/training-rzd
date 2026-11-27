import unittest
from unittest.mock import Mock

import cv2
import numpy as np

from autolabel_svc.runners.sam2_runner import Sam2Runner
from common import agent_graph, contours


class Sam2ContoursTest(unittest.TestCase):
    def test_raster_stairs_are_removed_below_the_vertex_limit(self):
        mask = np.zeros((128, 128), dtype=np.uint8)
        corners = np.array([[20, 30], [100, 50], [92, 82], [12, 62]], dtype=np.int32)
        cv2.fillPoly(mask, [corners], 1)
        part, = contours.polygons_from_mask(mask, 200, adaptive=True)
        self.assertEqual(len(part), 4)
        self.assertAlmostEqual(cv2.contourArea(np.array(part, dtype=np.int32)), cv2.contourArea(corners), delta=80)

    def test_same_adaptive_limit_in_editor_and_agent(self):
        counts = []
        for radius in (20, 200):
            with self.subTest(radius=radius):
                mask = np.zeros((600, 600), dtype=np.uint8)
                angles = np.arange(40) * (2 * np.pi / 40)
                radii = radius * np.tile([1.0, 0.65], 20)
                points = 300 + np.column_stack([np.cos(angles), np.sin(angles)]) * radii[:, None]
                cv2.fillPoly(mask, [points.round().astype(np.int32)], 1)
                bounds = contours.mask_bounds(mask)
                params = {"polygon_points": 32, "min_area": 0, "fill_holes": False}
                masks, scores = np.array([mask]), [0.9]
                runner = Sam2Runner.__new__(Sam2Runner)
                runner._select = Mock(return_value={"size": mask.shape})
                runner.predictor = Mock()
                runner.predictor.predict.return_value = masks, scores, None
                editor = runner.predict("unused", "image", {"points": [{"x": 300, "y": 300}]}, ["polygon"], params)
                agent = agent_graph.outline({"box": bounds}, masks, scores, params)
                parts = editor["shapes"][0]["polygons"]
                self.assertEqual(parts, agent["parts"])
                self.assertEqual(len(parts), 1)
                count = len(parts[0])
                self.assertLessEqual(count, 8 if radius == 20 else 32)
                self.assertGreater(cv2.contourArea(np.array(parts[0], dtype=np.int32)), 0)
                counts.append(count)

                low = {**params, "polygon_points": 8}
                editor_low = runner.predict("unused", "image", {"points": [{"x": 300, "y": 300}]}, ["polygon"], low)
                agent_low = agent_graph.outline({"box": bounds}, masks, scores, low)
                parts_low = editor_low["shapes"][0]["polygons"]
                self.assertEqual(parts_low, agent_low["parts"])
                self.assertLessEqual(len(parts_low[0]), 4 if radius == 20 else 8)
                self.assertGreater(cv2.contourArea(np.array(parts_low[0], dtype=np.int32)), 0)
        if len(counts) == 2:
            self.assertLess(*counts)

    @staticmethod
    def _star(radius, cx=960, cy=540, size=(1080, 1920)):
        mask = np.zeros(size, dtype=np.uint8)
        angles = np.arange(24) * (2 * np.pi / 24)
        radii = radius * np.tile([1.0, 0.55], 12)
        points = np.array([cx, cy]) + np.column_stack([np.cos(angles), np.sin(angles)]) * radii[:, None]
        cv2.fillPoly(mask, [points.round().astype(np.int32)], 1)
        return mask

    def test_small_complex_part_keeps_its_shape(self):
        mask = self._star(30)                       # 60 px на 1080p: прежде 4 точки, IoU 0,73
        part, = contours.polygons_from_mask(mask, 64, adaptive=True)
        self.assertEqual(len(part), 16)
        drawn = np.zeros_like(mask)
        cv2.fillPoly(drawn, [np.array(part, dtype=np.int32)], 1)
        union = np.logical_or(drawn, mask).sum()
        self.assertGreater(np.logical_and(drawn, mask).sum() / union, 0.8)

    def test_small_simple_part_stays_simple(self):
        mask = np.zeros((1080, 1920), dtype=np.uint8)
        mask[500:530, 900:940] = 1
        part, = contours.polygons_from_mask(mask, 64, adaptive=True)
        self.assertEqual(len(part), 4)

    def test_small_floor_follows_detail_factor(self):
        mask = self._star(30)
        low, = contours.polygons_from_mask(mask, 8, adaptive=True)
        high, = contours.polygons_from_mask(mask, 128, adaptive=True)
        self.assertLessEqual(len(low), 4)
        self.assertGreater(len(high), 16)
        self.assertLessEqual(len(high), 32)

    def test_medium_and_large_parts_keep_previous_limit(self):
        for radius in (80, 135, 400):
            with self.subTest(radius=radius):
                mask = self._star(radius)
                found, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
                _, _, w, h = cv2.boundingRect(found[0])
                share = min(1.0, 2 * max(w / 1920, h / 1080))
                self.assertGreaterEqual(share, contours.SMALL_SHARE)
                before = contours._limit_sam_contour(found[0], max(4, round(64 * share)))
                part, = contours.polygons_from_mask(mask, 64, adaptive=True)
                self.assertEqual(part, [[int(p[0][0]), int(p[0][1])] for p in before])
