# Contact Cone

The contact cone is the terminal piece that interfaces a support with the model.

## What it is

- The final support piece that touches the model.
- A cone with a small contact end and a larger socket side.

## Geometry

- Tip: the small contact face that touches the model.
- Cone body: the tapered section between the tip and socket.
- Socket side: connects directly to a joint, with no shaft between them.

## Behavior

- The cone axis follows the averaged surface normal under the contact footprint.
- The tip may embed slightly into the model surface.
- The cone is the terminal element for support types that end on the model.
- With the **Sphere** contact type (Support Studio's Contact Type, or an
  auto-support profile's Tip Type), a trunk, branch or leaf contact ends in a
  break-off ball of the chosen Ball Diameter instead of a disk. The ball rests on
  the surface, sunk by the penetration; it is never narrower than the contact, so
  the support breaks at the neck above it and leaves a small bump to sand off
  rather than a pit. Sticks, stumps and twigs keep their disk contacts.

## Constraints

- The contact face touches the model only.
- The socket side connects to a joint only.
- It does not connect directly to a shaft.
- The contact point is the highest point of the support: the cone leaves it
  downward, and its socket end stays at or below the tip.

## Related

- [Trunk](trunk.md)
- [Branch](branch.md)
- [Leaf](leaf.md)
- [Twig](twig.md)
- [Stick](stick.md)
- [Contact Tip Research](contact-tip-research.md)

