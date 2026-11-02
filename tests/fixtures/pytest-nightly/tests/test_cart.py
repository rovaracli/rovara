import pytest


def test_add():
    assert 1 + 1 == 2


def test_total_fails():
    assert 2 + 2 == 5


@pytest.mark.skip(reason="not yet")
def test_skipped():
    pass


@pytest.mark.parametrize("a,b", [(1, 2), (3, 4)])
def test_price(a, b):
    assert a < b


@pytest.mark.parametrize("label", ["a b"])
def test_label_with_space(label):
    assert label == "a b"


@pytest.mark.parametrize("label", ["x y"])
def test_label_with_space_fails(label):
    assert label == "other"
