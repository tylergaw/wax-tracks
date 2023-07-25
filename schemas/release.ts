export default {
  name: "release",
  type: "document",
  title: "Release",
  fields: [
    {
      name: "discogs_id",
      type: "string",
      title: "Discogs ID",
      readOnly: true,
    },
    {
      name: "title",
      type: "string",
      title: "Title",
    },
    {
      name: "year",
      type: "number",
      title: "Year released",
    },
    {
      name: "artists",
      type: "array",
      of: [
        {
          type: "reference",
          to: [
            {
              type: "artist",
            },
          ],
        },
      ],
      title: "Artists",
    },
  ],
};
