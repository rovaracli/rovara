class TestRules:
    def test_discount(self):
        assert True

    def test_discount_fails(self):
        assert False, "discount wrong"


class TestOther:
    class TestNested:
        def test_deep(self):
            assert True
