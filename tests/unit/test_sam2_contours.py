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
