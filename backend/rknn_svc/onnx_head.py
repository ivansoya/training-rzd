# Перекройка головы Detect в ONNX под квантование: девять выходов вместо одного
#
# Ultralytics отдаёт один тензор [1, 4+nc, anchors], где боксы в пикселях (до 640)
# и вероятности (0..1) лежат рядом. RKNN квантует тензор одной шкалой, поэтому
# в INT8 вероятности схлопываются в две-три ступени. Здесь граф режется на
# финальных свёртках cv2 (бокс) и cv3 (классы) каждого уровня, к классам
# добавляется сигмоида, а третьим тензором уровня идёт сумма вероятностей,
# зажатая в 0..1, по ней декодер отбрасывает пустые якоря до чтения классов.
# Это раскладка rknn_model_zoo для yolov8 и yolo11, у yolo26 бокс без DFL,
# 4 канала вместо 64, структура та же.
#
# У головы Segment на уровень добавляется четвёртый тензор seg_l* — коэффициенты
# масок cv4 [1, nm, H, W], последним выходом идёт прото масок proto [1, nm, H/4, W/4]:
# всего тринадцать выходов, как у yolov8-seg в rknn_model_zoo.

import re

import onnx
from onnx import helper, shape_inference, TensorProto

BOX_CONV = re.compile(r"^/model\.(\d+)/cv2\.(\d)/cv2\.\d\.2/Conv$")
CLS_CONV = re.compile(r"^/model\.(\d+)/cv3\.(\d)/cv3\.\d\.2/Conv$")
SEG_CONV = re.compile(r"^/model\.(\d+)/cv4\.(\d)/cv4\.\d\.2/Conv$")


def find_head_convs(model):
    # Возвращает {уровень: (box_conv, cls_conv, seg_conv или None)} финальных свёрток головы
    box, cls, seg = {}, {}, {}
    for node in model.graph.node:
        if node.op_type != "Conv":
            continue
        m = BOX_CONV.match(node.name)
        if m:
            box[int(m.group(2))] = node
        m = CLS_CONV.match(node.name)
        if m:
            cls[int(m.group(2))] = node
        m = SEG_CONV.match(node.name)
        if m:
            seg[int(m.group(2))] = node
    if not box or set(box) != set(cls):
        raise RuntimeError("head convs not found: box levels %s, cls levels %s" % (sorted(box), sorted(cls)))
    if seg and set(seg) != set(box):
        raise RuntimeError("mask convs levels %s differ from box levels %s" % (sorted(seg), sorted(box)))
    return {i: (box[i], cls[i], seg.get(i)) for i in sorted(box)}


def tensor_shape(model, name):
    for vi in list(model.graph.value_info) + list(model.graph.output) + list(model.graph.input):
        if vi.name == name:
            return [d.dim_value for d in vi.type.tensor_type.shape.dim]
    raise RuntimeError("no shape for tensor " + name)


def keep_only_producers(model, keep_outputs):
    # Оставляет узлы, от которых зависят keep_outputs, в исходном топологическом порядке
    producer = {}
    for node in model.graph.node:
        for out in node.output:
            producer[out] = node
    needed = set()
    stack = list(keep_outputs)
    while stack:
        name = stack.pop()
        node = producer.get(name)
        if node is None or id(node) in needed:
            continue
        needed.add(id(node))
        stack.extend(node.input)
    kept = [n for n in model.graph.node if id(n) in needed]
    del model.graph.node[:]
    model.graph.node.extend(kept)


def split_head(src_path, dst_path):
    model = onnx.load(src_path)
    version = next((op.version for op in model.opset_import if op.domain in ('', 'ai.onnx')), None)
    if version != 12:
        raise ValueError(f'Для INT8 требуется ONNX opset 12, получен {version}.')
    model = shape_inference.infer_shapes(model)
    levels = find_head_convs(model)

    outputs = []
    new_nodes = []
    keep = []
    for i, (box_conv, cls_conv, seg_conv) in levels.items():
        stride_tag = "l%d" % i
        cls_raw = cls_conv.output[0]
        shape = tensor_shape(model, cls_raw)

        # Выход свёртки бокса переименовывается прямо в узле: потребителей у него после обрезки нет
        box_shape = tensor_shape(model, box_conv.output[0])
        box_out = "box_" + stride_tag
        box_conv.output[0] = box_out

        cls_out = "cls_" + stride_tag
        sum_raw = "sum_raw_" + stride_tag
        sum_out = "sum_" + stride_tag

        new_nodes.append(helper.make_node("Sigmoid", [cls_raw], [cls_out], name="/head/sigmoid_" + stride_tag))
        new_nodes.append(helper.make_node("ReduceSum", [cls_out], [sum_raw], name="/head/sum_" + stride_tag,
                                          axes=[1], keepdims=1))
        new_nodes.append(helper.make_node("Clip", [sum_raw, "clip_min", "clip_max"], [sum_out],
                                          name="/head/clip_" + stride_tag))

        outputs.append(helper.make_tensor_value_info(box_out, TensorProto.FLOAT, box_shape))
        outputs.append(helper.make_tensor_value_info(cls_out, TensorProto.FLOAT, shape))
        outputs.append(helper.make_tensor_value_info(sum_out, TensorProto.FLOAT, [shape[0], 1, shape[2], shape[3]]))
        keep += [box_out, cls_raw]

        if seg_conv is not None:
            seg_shape = tensor_shape(model, seg_conv.output[0])
            seg_out = "seg_" + stride_tag
            seg_conv.output[0] = seg_out
            outputs.append(helper.make_tensor_value_info(seg_out, TensorProto.FLOAT, seg_shape))
            keep.append(seg_out)

    if any(seg for _, _, seg in levels.values()):
        # Прото — четырёхмерный выход ultralytics, переименовывается в узле-производителе
        proto = next(o for o in model.graph.output if len(o.type.tensor_type.shape.dim) == 4)
        proto_shape = [d.dim_value for d in proto.type.tensor_type.shape.dim]
        for node in model.graph.node:
            node.output[:] = ["proto" if o == proto.name else o for o in node.output]
        outputs.append(helper.make_tensor_value_info("proto", TensorProto.FLOAT, proto_shape))
        keep.append("proto")

    keep_only_producers(model, keep)

    model.graph.initializer.extend([
        helper.make_tensor("clip_min", TensorProto.FLOAT, [], [0.0]),
        helper.make_tensor("clip_max", TensorProto.FLOAT, [], [1.0]),
    ])
    model.graph.node.extend(new_nodes)
    del model.graph.output[:]
    model.graph.output.extend(outputs)

    onnx.checker.check_model(model)
    onnx.save(model, dst_path)
    return [(o.name, [d.dim_value for d in o.type.tensor_type.shape.dim]) for o in outputs]


def describe(path):
    model = onnx.load(path)
    return [(o.name, [d.dim_value for d in o.type.tensor_type.shape.dim]) for o in model.graph.output]
