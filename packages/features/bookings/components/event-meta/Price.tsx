export const EventPrice = ({ product }) => {
  if (product.price === 0) return null;

  return (
    <>
      {Intl.NumberFormat("en", {
        style: "currency",
        currency: product.currency.toUpperCase(),
      }).format(product.price / 100.0)}
    </>
  );
};
