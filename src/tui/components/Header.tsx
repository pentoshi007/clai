import { Box, Text } from "ink";

export interface HeaderProps {
  version: string;
  provider: string;
  model: string;
  mode: string;
}

export function Header({ version, provider, model, mode }: HeaderProps) {
  return (
    <Box
      borderStyle="round"
      borderColor="magenta"
      paddingX={1}
      flexDirection="row"
      justifyContent="space-between"
    >
      <Text>
        <Text color="magenta">●</Text> <Text bold>clai</Text>{" "}
        <Text dimColor>v{version}</Text>
      </Text>
      <Text>
        <Text dimColor>mode </Text>
        <Text color="yellow">{mode}</Text>
        <Text dimColor>  ·  </Text>
        <Text color="green">{provider}</Text>
        <Text dimColor> / </Text>
        <Text color="cyan">{model}</Text>
      </Text>
    </Box>
  );
}
